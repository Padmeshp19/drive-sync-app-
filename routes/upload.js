const express = require('express');
const axios = require('axios');
const { getDriveClient } = require('../auth/google');
const { refreshTokens } = require('../auth/microsoft');
const { Readable } = require('stream');
const { randomUUID } = require('crypto');
const { createLimiter } = require('../utils/limiter');

const router = express.Router();

// How many Drive API calls run at once while enumerating a folder tree
// before the sync even starts. Previously every child (and every recursive
// subfolder) was awaited one at a time, so a selection with many nested
// folders could sit silently "calculating" for a long time with zero
// progress sent to the client.
const WALK_CONCURRENCY = 8;

// SSE connections that go quiet for too long get killed by browsers and by
// hosting-platform reverse proxies (Render closes idle connections after a
// stretch with no bytes sent). The old code sent nothing at all during the
// walk phase, so a large selection could trip that idle timeout — the
// client would see the connection drop and the server would report
// "Sync cancelled by user" even though nobody clicked anything. A periodic
// SSE comment line keeps bytes flowing without meaning anything to the
// client's event parser.
const HEARTBEAT_INTERVAL_MS = 15_000;

const activeSyncs = new Map();

function requireAuth(req, res, next) {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  if (!req.session.msTokens) return res.status(401).json({ error: 'Not authenticated with Microsoft' });
  next();
}

function isAbortLike(err) {
  return Boolean(err) && (
    err.name === 'AbortError' ||
    err.code === 'ERR_CANCELED' ||
    err.code === 'ECONNABORTED' ||
    /sync cancelled/i.test(err.message || '')
  );
}

const STALL_TIMEOUT_MS = 45_000; // no bytes moved for 45s = treat the transfer as dead
const AXIOS_TIMEOUT_MS = 60_000;

// Wraps a readable stream so it self-destructs if no 'data' event arrives
// within STALL_TIMEOUT_MS. Without this, a network hiccup mid-download or
// mid-upload leaves the surrounding `for await (const chunk of stream)`
// waiting forever — nothing else in the queue ever runs, and there's no
// error for withBackoff() to retry on, because the stall happens *after*
// the initial request already succeeded.
function withStallGuard(stream, signal, label) {
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new Error(`Stalled: no data received for ${STALL_TIMEOUT_MS / 1000}s (${label})`);
      err.code = 'ESTALLED';
      stream.destroy(err);
    }, STALL_TIMEOUT_MS);
  };
  const clear = () => clearTimeout(timer);
  arm();
  stream.on('data', arm);
  stream.on('end', clear);
  stream.on('close', clear);
  stream.on('error', clear);
  if (signal) {
    signal.addEventListener('abort', () => {
      clear();
      stream.destroy(new Error('Sync cancelled'));
    }, { once: true });
  }
  return stream;
}

async function withBackoff(fn, retries = 5, delay = 500, signal = null) {
  if (signal?.aborted) throw new Error('Sync cancelled');

  try {
    return await fn();
  } catch (err) {
    if (isAbortLike(err)) throw new Error('Sync cancelled');

    const status = err.response?.status || err.code;
    if ((status === 429 || status === 503) && retries > 0) {
      const retryAfter = err.response?.headers?.['retry-after'];
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;

      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Sync cancelled'));
        const timer = setTimeout(resolve, wait);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Sync cancelled'));
          }, { once: true });
        }
      });

      return withBackoff(fn, retries - 1, delay * 2, signal);
    }

    throw err;
  }
}

async function ensureMsToken(req) {
  const tokens = req.session.msTokens;
  if (Date.now() < (tokens.obtainedAt + tokens.expires_in * 1000) - 60000) {
    return tokens.access_token;
  }

  const fresh = await refreshTokens(tokens.refresh_token);
  req.session.msTokens = { ...fresh, obtainedAt: Date.now() };
  return fresh.access_token;
}

async function walkDrive(drive, fileId, isFolder, relPath, out, visitedFolders = new Set(), signal = null, limit = null) {
  if (signal?.aborted) throw new Error('Sync cancelled');

  // Share one limiter across an entire top-level walk so recursive calls
  // stay bounded together rather than each spawning their own pool.
  const runLimited = limit || createLimiter(WALK_CONCURRENCY);

  if (!isFolder) {
    const meta = await getResolvedFileMeta(drive, fileId, signal);
    if (!meta) return;
    if (meta.mimeType === FOLDER_MIME) {
      return walkDrive(drive, meta.id, true, relPath, out, visitedFolders, signal, runLimited);
    }
    out.push({
      id: meta.id,
      relPath,
      mimeType: meta.mimeType,
      name: relPath.split('/').pop(),
      size: meta.size == null ? null : Number(meta.size),
      fileExtension: meta.fileExtension || '',
      shortcutDetails: null,
    });
    return;
  }

  if (visitedFolders.has(fileId)) return;
  visitedFolders.add(fileId);

  let pageToken;
  do {
    if (signal?.aborted) throw new Error('Sync cancelled');

    const res = await withBackoff(() => drive.files.list({
      q: `'${fileId}' in parents and trashed = false`,
      spaces: 'drive',
      corpora: 'user',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'nextPageToken, files(id,name,mimeType,size,fileExtension,shortcutDetails(targetId,targetMimeType),capabilities(canDownload))',
      pageSize: 1000,
      pageToken,
      orderBy: 'folder,name',
    }), 5, 500, signal);

    // Process this page's children concurrently (bounded by `runLimited`)
    // instead of awaiting each child — including each recursive subfolder
    // walk — one at a time before starting the next.
    await Promise.all(
      (res.data.files || []).map((child) =>
        runLimited(async () => {
          if (signal?.aborted) throw new Error('Sync cancelled');

          const isShortcut = child.mimeType === SHORTCUT_MIME;
          const targetMimeType = child.shortcutDetails?.targetMimeType || '';
          const shortcutTargetId = child.shortcutDetails?.targetId || '';

          // A shortcut to a folder must be traversed through the TARGET folder ID.
          // Walking the shortcut ID itself returns no children and eventually causes
          // the shortcut to be treated like a non-downloadable binary file.
          if (isShortcut && shortcutTargetId) {
            const targetMeta = await getResolvedFileMeta(drive, shortcutTargetId, signal);
            if (!targetMeta) {
              return;
            }

            if (targetMeta.mimeType === FOLDER_MIME || targetMimeType === FOLDER_MIME) {
              await walkDrive(
                drive,
                targetMeta.id,
                true,
                `${relPath}/${child.name}`,
                out,
                visitedFolders,
                signal,
                runLimited
              );
              return;
            }

            // Shortcut to a real file: store the TARGET file ID so a direct reference
            // and a shortcut to the same target are deduplicated later.
            out.push({
              id: targetMeta.id,
              relPath: `${relPath}/${child.name}`,
              mimeType: targetMeta.mimeType,
              name: child.name,
              size: targetMeta.size == null ? null : Number(targetMeta.size),
              fileExtension: targetMeta.fileExtension || '',
              shortcutDetails: child.shortcutDetails,
            });
            return;
          }

          const childIsFolder = child.mimeType === FOLDER_MIME;

          if (childIsFolder) {
            await walkDrive(
              drive,
              child.id,
              true,
              `${relPath}/${child.name}`,
              out,
              visitedFolders,
              signal,
              runLimited
            );
          } else {
            out.push({
              id: child.id,
              relPath: `${relPath}/${child.name}`,
              mimeType: child.mimeType,
              name: child.name,
              size: child.size == null ? null : Number(child.size),
              fileExtension: child.fileExtension || '',
              shortcutDetails: child.shortcutDetails || null,
            });
          }
        })
      )
    );

    pageToken = res.data.nextPageToken;
  } while (pageToken);
}

const GOOGLE_EXPORTS = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const FILE_META_FIELDS = 'id,name,mimeType,size,fileExtension,webViewLink,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)';

function getExportInfo(mimeType) {
  return GOOGLE_EXPORTS[mimeType] || null;
}

function isGoogleWorkspaceFile(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('application/vnd.google-apps.') && mimeType !== FOLDER_MIME && mimeType !== SHORTCUT_MIME;
}

function isFileNotDownloadableError(err) {
  const status = err.response?.status;
  const message = String(err.response?.data?.error?.message || err.message || '');
  const reason = String(err.response?.data?.error?.errors?.[0]?.reason || '');
  return status === 403 && (
    /only files with binary content/i.test(message) ||
    /filenotdownloadable/i.test(reason) ||
    /fileNotDownloadable/i.test(message)
  );
}

function isFileNotFoundError(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const message = String(err?.response?.data?.error?.message || err?.message || '');
  return status === 404 || code === 404 || /file not found/i.test(message) || /notFound/i.test(message);
}

async function getResolvedFileMeta(drive, fileId, signal, seen = new Set()) {
  if (seen.has(fileId)) throw new Error('Shortcut cycle detected');
  if (seen.size > 8) throw new Error('Shortcut chain is too deep');
  seen.add(fileId);

  let response;
  try {
    response = await withBackoff(() => drive.files.get({
      fileId,
      fields: FILE_META_FIELDS,
      supportsAllDrives: true,
    }), 5, 500, signal);
  } catch (err) {
    if (isFileNotFoundError(err)) return null;
    throw err;
  }

  const meta = response.data;

  // Drive shortcuts contain no binary content themselves. Resolve the target
  // before attempting export/download. Google documents shortcutDetails.targetId
  // and targetMimeType specifically for this purpose.
  if (meta.mimeType === SHORTCUT_MIME && meta.shortcutDetails?.targetId) {
    const target = await getResolvedFileMeta(drive, meta.shortcutDetails.targetId, signal, seen);
    return {
      ...target,
      shortcutName: meta.name,
    };
  }

  return meta;
}

async function getDriveFileStream(drive, file, signal) {
  const exportInfo = getExportInfo(file.mimeType);

  if (exportInfo) {
    const response = await withBackoff(() => drive.files.export(
      { fileId: file.id, mimeType: exportInfo.mimeType },
      { responseType: 'stream', signal }
    ), 5, 500, signal);

    return {
      stream: withStallGuard(response.data, signal, `export ${file.name}`),
      size: null,
      exportExtension: exportInfo.extension,
      exported: true,
    };
  }

  // Google Workspace files without a supported export format cannot be sent
  // through alt=media. Skip them cleanly instead of failing the whole sync.
  const fallbackLink = file.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`;

  if (isGoogleWorkspaceFile(file.mimeType)) {
    return {
      stream: null,
      size: null,
      exportExtension: '',
      exported: false,
      unsupported: true,
      linkOnly: true,
      linkUrl: fallbackLink,
      unsupportedReason: `Google Workspace file type ${file.mimeType} has no supported Drive export format`,
    };
  }

  if (file.capabilities && file.capabilities.canDownload === false) {
    return {
      stream: null,
      size: null,
      exportExtension: '',
      exported: false,
      unsupported: true,
      linkOnly: true,
      linkUrl: fallbackLink,
      unsupportedReason: 'Google Drive does not allow this file to be downloaded',
    };
  }

  try {
    const response = await withBackoff(() => drive.files.get(
      { fileId: file.id, alt: 'media', acknowledgeAbuse: true },
      { responseType: 'stream', signal }
    ), 5, 500, signal);

    return {
      stream: withStallGuard(response.data, signal, `download ${file.name}`),
      size: file.size == null ? null : Number(file.size),
      exportExtension: '',
      exported: false,
      unsupported: false,
    };
  } catch (err) {
    // A metadata-only Google item should never crash the entire batch.
    if (isFileNotDownloadableError(err)) {
      return {
        stream: null,
        size: null,
        exportExtension: '',
        exported: false,
        unsupported: true,
        unsupportedReason: 'Google Drive reported this item as not downloadable; skipped and continuing',
      };
    }
    throw err;
  }
}

async function bufferStream(stream, signal = null) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    if (signal?.aborted) {
      stream.destroy?.(new Error('Sync cancelled'));
      throw new Error('Sync cancelled');
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
  }
  return { buffer: Buffer.concat(chunks, size), size };
}

async function getOneDriveItem(accessToken, oneDrivePath, signal) {
  const encodedPath = oneDrivePath.split('/').map(encodeURIComponent).join('/');
  try {
    const response = await withBackoff(() => axios.get(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { '$select': 'id,name,file,folder,size,lastModifiedDateTime' },
        signal,
        timeout: 20000,
      }
    ), 3, 400, signal);
    return response.data?.id ? response.data : null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function oneDriveItemExists(accessToken, oneDrivePath, signal) {
  return Boolean(await getOneDriveItem(accessToken, oneDrivePath, signal));
}

function addPathSuffix(filePath, n) {
  const slash = filePath.lastIndexOf('/');
  const dir = slash >= 0 ? filePath.slice(0, slash + 1) : '';
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${dir}${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${dir}${name} (${n})`;
}

function claimUniquePath(basePath, claimedPaths) {
  let candidate = basePath;
  let n = 2;
  while (claimedPaths.has(candidate.toLowerCase())) {
    candidate = addPathSuffix(basePath, n++);
  }
  claimedPaths.add(candidate.toLowerCase());
  return candidate;
}

function makeDriveLinkContent(url) {
  return `[InternetShortcut]\r\nURL=${url}\r\n`;
}

async function uploadToOneDrive(accessToken, oneDrivePath, stream, sizeBytes, signal) {
  const encodedPath = oneDrivePath.split('/').map(encodeURIComponent).join('/');

  if (sizeBytes && sizeBytes > 4 * 1024 * 1024) {
    const sessionRes = await withBackoff(() => axios.post(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/createUploadSession`,
      { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
      { headers: { Authorization: `Bearer ${accessToken}` }, signal, timeout: 30000 }
    ), 5, 500, signal);

    const uploadUrl = sessionRes.data.uploadUrl;
    // Microsoft Graph recommends 5-10 MiB chunks for resumable uploads
    // (fragment size must be a multiple of 320 KiB; 10 MiB qualifies).
    // Doubling from 5 MiB halves the number of PUT round trips for large
    // files, which is most of the win here since each round trip pays a
    // full network RTT plus Graph-side processing on top of transfer time.
    const chunkSize = 10 * 1024 * 1024;
    let offset = 0;
    let accumulator = Buffer.alloc(0);

    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('Sync cancelled');
      accumulator = Buffer.concat([accumulator, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

      while (accumulator.length >= chunkSize) {
        const slice = accumulator.subarray(0, chunkSize);
        accumulator = accumulator.subarray(chunkSize);
        await withBackoff(() => axios.put(uploadUrl, slice, {
          headers: {
            'Content-Length': slice.length,
            'Content-Range': `bytes ${offset}-${offset + slice.length - 1}/${sizeBytes}`,
          },
          signal,
          timeout: AXIOS_TIMEOUT_MS,
        }), 5, 500, signal);
        offset += slice.length;
      }
    }

    if (accumulator.length > 0) {
      await withBackoff(() => axios.put(uploadUrl, accumulator, {
        headers: {
          'Content-Length': accumulator.length,
          'Content-Range': `bytes ${offset}-${offset + accumulator.length - 1}/${sizeBytes}`,
        },
        signal,
        timeout: Math.max(AXIOS_TIMEOUT_MS, 120000),
      }), 5, 500, signal);
      offset += accumulator.length;
    }

    if (offset !== sizeBytes) {
      throw new Error(`Uploaded ${offset} bytes but expected ${sizeBytes}`);
    }
  } else {
    const buffered = [];
    let total = 0;
    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('Sync cancelled');
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered.push(buf);
      total += buf.length;
    }

    const body = Buffer.concat(buffered, total);
    await withBackoff(() => axios.put(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/content`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
        },
        signal,
        timeout: AXIOS_TIMEOUT_MS,
      }
    ), 5, 500, signal);
  }
}

router.post('/sync', requireAuth, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const syncId = randomUUID();
  const syncController = new AbortController();
  activeSyncs.set(syncId, { controller: syncController, createdAt: Date.now() });

  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  // A dropped SSE/browser connection does NOT cancel the sync. Explicit
  // cancellation is sent through /sync/cancel.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_INTERVAL_MS);

  const { items, destFolder } = req.body;
  const drive = getDriveClient(req.session.googleTokens);
  const dest = destFolder || 'DriveSync';

  try {
    const flatFiles = [];
    const seenFiles = new Set();
    const walkLimit = createLimiter(WALK_CONCURRENCY);

    const collectedPerItem = await Promise.all(
      (items || []).map((item) =>
        walkLimit(async () => {
          if (syncController.signal.aborted) throw new Error('Sync cancelled');
          const collected = [];
          await walkDrive(
            drive,
            item.id,
            item.isFolder,
            item.name,
            collected,
            new Set(),
            syncController.signal,
            walkLimit
          );
          return collected;
        })
      )
    );

    for (const collected of collectedPerItem) {
      for (const file of collected) {
        if (seenFiles.has(file.id)) continue;
        seenFiles.add(file.id);
        flatFiles.push(file);
      }
    }

    send('start', { total: flatFiles.length, syncId });

    let done = 0;
    let skipped = 0;
    let existing = 0;
    let linked = 0;
    let nextIndex = 0;
    const claimedPaths = new Set();
    const CONCURRENCY = 5;

    async function worker() {
      while (true) {
        if (syncController.signal.aborted) throw new Error('Sync cancelled');
        const index = nextIndex++;
        if (index >= flatFiles.length) return;
        const file = flatFiles[index];

        try {
          send('status', { done, total: flatFiles.length, current: file.relPath, phase: 'checking' });

          const originalMeta = await getResolvedFileMeta(drive, file.id, syncController.signal);
          if (!originalMeta) {
            done += 1;
            skipped += 1;
            send('progress', {
              done,
              total: flatFiles.length,
              current: file.relPath,
              skipped: true,
              reason: 'File no longer exists in Google Drive — skipped and continuing',
            });
            continue;
          }

          const displayName = file.name || originalMeta.name;
          let oneDrivePath = claimUniquePath(`${dest}/${file.relPath}`, claimedPaths);
          let accessToken = await ensureMsToken(req);

          // If a destination folder already occupies the source file's path,
          // preserve the file with a deterministic suffix instead of failing 409.
          let existingItem = await getOneDriveItem(accessToken, oneDrivePath, syncController.signal);
          if (existingItem?.folder) {
            let n = 2;
            let candidate = addPathSuffix(oneDrivePath, n);
            while (await getOneDriveItem(accessToken, candidate, syncController.signal)) {
              candidate = addPathSuffix(oneDrivePath, ++n);
            }
            claimedPaths.add(candidate.toLowerCase());
            oneDrivePath = candidate;
            existingItem = null;
          }

          if (existingItem?.file) {
            done += 1;
            existing += 1;
            send('progress', {
              done,
              total: flatFiles.length,
              current: file.relPath,
              skipped: true,
              existing: true,
              reason: 'Already exists in OneDrive — skipped',
            });
            continue;
          }

          send('status', { done, total: flatFiles.length, current: file.relPath, phase: 'downloading' });

          const transfer = await getDriveFileStream(
            drive,
            { ...originalMeta, id: originalMeta.id, name: displayName },
            syncController.signal
          );

          // Google Workspace items without a transferable binary (e.g. Forms)
          // are preserved as a Windows Internet Shortcut so nothing is lost.
          if (transfer.linkOnly) {
            let linkPath = oneDrivePath.toLowerCase().endsWith('.url')
              ? oneDrivePath
              : `${oneDrivePath}.url`;
            if (claimedPaths.has(linkPath.toLowerCase())) {
              linkPath = claimUniquePath(linkPath, claimedPaths);
            } else {
              claimedPaths.add(linkPath.toLowerCase());
            }

            accessToken = await ensureMsToken(req);
            const linkExisting = await getOneDriveItem(accessToken, linkPath, syncController.signal);
            if (linkExisting?.file) {
              done += 1;
              existing += 1;
              send('progress', {
                done,
                total: flatFiles.length,
                current: file.relPath,
                skipped: true,
                existing: true,
                reason: 'Drive link already exists in OneDrive — skipped',
              });
              continue;
            }

            const body = Buffer.from(makeDriveLinkContent(transfer.linkUrl), 'utf8');
            await uploadToOneDrive(
              accessToken,
              linkPath,
              Readable.from(body),
              body.length,
              syncController.signal
            );

            done += 1;
            linked += 1;
            send('progress', {
              done,
              total: flatFiles.length,
              current: file.relPath,
              skipped: false,
              linked: true,
              destination: linkPath,
            });
            continue;
          }

          let stream = transfer.stream;
          let size = transfer.size;

          if (transfer.exportExtension && !oneDrivePath.toLowerCase().endsWith(transfer.exportExtension)) {
            oneDrivePath += transfer.exportExtension;
          }

          // Re-check after adding an export extension.
          existingItem = await getOneDriveItem(accessToken, oneDrivePath, syncController.signal);
          if (existingItem?.folder) {
            let n = 2;
            let candidate = addPathSuffix(oneDrivePath, n);
            while (await getOneDriveItem(accessToken, candidate, syncController.signal)) {
              candidate = addPathSuffix(oneDrivePath, ++n);
            }
            claimedPaths.add(candidate.toLowerCase());
            oneDrivePath = candidate;
            existingItem = null;
          }

          if (existingItem?.file) {
            done += 1;
            existing += 1;
            send('progress', {
              done,
              total: flatFiles.length,
              current: file.relPath,
              skipped: true,
              existing: true,
              reason: 'Already exists in OneDrive — skipped',
            });
            continue;
          }

          if (transfer.exportExtension) {
            const buffered = await bufferStream(stream, syncController.signal);
            stream = Readable.from(buffered.buffer);
            size = buffered.size;
          }

          send('status', { done, total: flatFiles.length, current: file.relPath, phase: 'uploading' });

          try {
            await uploadToOneDrive(accessToken, oneDrivePath, stream, size, syncController.signal);
          } catch (uploadErr) {
            if (uploadErr.response?.status !== 409) throw uploadErr;

            // A 409 usually means a race or a destination collision. Re-fetch
            // the source stream and retry once using a unique destination name.
            let n = 2;
            let retryPath = addPathSuffix(oneDrivePath, n);
            while (await getOneDriveItem(accessToken, retryPath, syncController.signal)) {
              retryPath = addPathSuffix(oneDrivePath, ++n);
            }
            claimedPaths.add(retryPath.toLowerCase());

            const retryTransfer = await getDriveFileStream(
              drive,
              { ...originalMeta, id: originalMeta.id, name: displayName },
              syncController.signal
            );

            if (retryTransfer.linkOnly) {
              retryPath = retryPath.toLowerCase().endsWith('.url') ? retryPath : `${retryPath}.url`;
              const body = Buffer.from(makeDriveLinkContent(retryTransfer.linkUrl), 'utf8');
              await uploadToOneDrive(accessToken, retryPath, Readable.from(body), body.length, syncController.signal);
              linked += 1;
            } else {
              let retryStream = retryTransfer.stream;
              let retrySize = retryTransfer.size;
              if (retryTransfer.exportExtension) {
                if (!retryPath.toLowerCase().endsWith(retryTransfer.exportExtension)) {
                  retryPath += retryTransfer.exportExtension;
                }
                const buffered = await bufferStream(retryStream, syncController.signal);
                retryStream = Readable.from(buffered.buffer);
                retrySize = buffered.size;
              }
              await uploadToOneDrive(accessToken, retryPath, retryStream, retrySize, syncController.signal);
            }
            oneDrivePath = retryPath;
          }

          done += 1;
          send('progress', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            skipped: false,
            destination: oneDrivePath,
          });

        } catch (fileErr) {
          if (syncController.signal.aborted || isAbortLike(fileErr)) {
            throw new Error('Sync cancelled');
          }

          done += 1;
          skipped += 1;
          console.warn(`Skipping ${file.relPath}:`, fileErr.message);
          send('progress', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            skipped: true,
            reason: fileErr.message,
          });
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, flatFiles.length) }, () => worker())
    );

    send('complete', {
      done,
      total: flatFiles.length,
      skipped,
      existing,
      linked,
    });
  } catch (err) {
    if (syncController.signal.aborted || isAbortLike(err)) {
      if (!res.destroyed && !res.writableEnded) {
        send('cancelled', { message: 'Sync cancelled' });
      }
      console.log('Sync cancelled by user.');
    } else {
      console.error('Sync error:', err.message);
      if (!res.destroyed && !res.writableEnded) {
        send('error', { message: err.message });
      }
    }
  } finally {
    clearInterval(heartbeat);
    activeSyncs.delete(syncId);
    res.end();
  }
});

router.post('/sync/cancel', requireAuth, (req, res) => {
  const syncId = String(req.body?.syncId || '');
  const job = activeSyncs.get(syncId);
  if (!syncId || !job) {
    return res.status(404).json({ error: 'Sync job not found' });
  }
  job.controller.abort();
  return res.json({ ok: true, cancelled: true });
});

module.exports = router;
