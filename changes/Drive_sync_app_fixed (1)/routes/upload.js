const express = require('express');
const axios = require('axios');
const { getDriveClient } = require('../auth/google');
const { refreshTokens } = require('../auth/microsoft');
const { Readable } = require('stream');
const { createLimiter } = require('../utils/limiter');
const { isRetryableError } = require('../utils/retry');

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

function requireAuth(req, res, next) {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  if (!req.session.msTokens) return res.status(401).json({ error: 'Not authenticated with Microsoft' });
  next();
}

function isAbortLike(err) {
  // NOTE: ECONNABORTED is deliberately *not* included here. That's axios's
  // code for its own request timeout (oneDriveItemExists uses a 20s
  // timeout, uploads use 60-120s) — nothing to do with the sync actually
  // being cancelled. Treating it as a cancellation was the real bug behind
  // syncs stopping mid-way with no user action and no genuine disconnect:
  // one slow Graph API call past its timeout was enough to abort the
  // entire batch. A timeout should be retried (utils/retry.js already
  // treats ECONNABORTED as retryable), not treated as "stop everything."
  return Boolean(err) && (
    err.name === 'AbortError' ||
    err.name === 'CanceledError' ||
    err.code === 'ERR_CANCELED' ||
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

    // Retry HTTP 429/503 *and* transient network failures (ETIMEDOUT,
    // ENETUNREACH, ECONNRESET, DNS hiccups, ...). Previously only 429/503
    // were retried here, so any connectivity blip to Google or Microsoft's
    // servers failed the request on the first try with no retry at all —
    // that's the "connect ETIMEDOUT ..." / "connect ENETUNREACH ..."
    // entries that showed up as permanently skipped files.
    if (isRetryableError(err) && retries > 0) {
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

async function collectDriveItems(drive, items, signal, send = null) {
  const out = [];
  const seenFolders = new Set();
  const limiter = createLimiter(WALK_CONCURRENCY);
  let current = (items || []).map((item) => ({
    id: item.id,
    isFolder: Boolean(item.isFolder),
    relPath: item.name || item.id,
  }));
  let scanned = 0;

  while (current.length > 0) {
    if (signal?.aborted) throw new Error('Sync cancelled');

    const next = [];

    // IMPORTANT: process one queue level at a time. A worker never holds a
    // limiter slot while recursively waiting for another limiter slot. This
    // avoids the deadlock that caused large selections to sit at "Starting…".
    await Promise.all(current.map((task) => limiter(async () => {
      if (signal?.aborted) throw new Error('Sync cancelled');

      if (task.isFolder) {
        if (seenFolders.has(task.id)) return;
        seenFolders.add(task.id);

        let pageToken;
        do {
          if (signal?.aborted) throw new Error('Sync cancelled');

          const res = await withBackoff(() => drive.files.list({
            q: `'${task.id}' in parents and trashed = false`,
            spaces: 'drive',
            corpora: 'user',
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: 'nextPageToken, files(id,name,mimeType,size,fileExtension,shortcutDetails(targetId,targetMimeType),capabilities(canDownload))',
            pageSize: 1000,
            pageToken,
            orderBy: 'folder,name',
          }), 5, 500, signal);

          for (const child of res.data.files || []) {
            if (signal?.aborted) throw new Error('Sync cancelled');

            const childPath = `${task.relPath}/${child.name}`;
            const isShortcut = child.mimeType === SHORTCUT_MIME;
            const targetId = child.shortcutDetails?.targetId || '';
            const targetMimeType = child.shortcutDetails?.targetMimeType || '';

            if (isShortcut && targetId) {
              const targetMeta = await getResolvedFileMeta(drive, targetId, signal);
              if (!targetMeta) {
                scanned += 1;
                continue;
              }

              if (targetMeta.mimeType === FOLDER_MIME || targetMimeType === FOLDER_MIME) {
                next.push({
                  id: targetMeta.id,
                  isFolder: true,
                  relPath: childPath,
                });
              } else {
                out.push({
                  id: targetMeta.id,
                  relPath: childPath,
                  mimeType: targetMeta.mimeType,
                  name: child.name,
                  size: targetMeta.size == null ? null : Number(targetMeta.size),
                  fileExtension: targetMeta.fileExtension || '',
                  shortcutDetails: child.shortcutDetails,
                });
              }
              scanned += 1;
              continue;
            }

            if (child.mimeType === FOLDER_MIME) {
              next.push({
                id: child.id,
                isFolder: true,
                relPath: childPath,
              });
            } else {
              out.push({
                id: child.id,
                relPath: childPath,
                mimeType: child.mimeType,
                name: child.name,
                size: child.size == null ? null : Number(child.size),
                fileExtension: child.fileExtension || '',
                shortcutDetails: child.shortcutDetails || null,
              });
            }

            scanned += 1;
          }

          pageToken = res.data.nextPageToken;
        } while (pageToken);
      } else {
        const meta = await getResolvedFileMeta(drive, task.id, signal);
        if (!meta) {
          scanned += 1;
          return;
        }

        if (meta.mimeType === FOLDER_MIME) {
          next.push({
            id: meta.id,
            isFolder: true,
            relPath: task.relPath,
          });
        } else {
          out.push({
            id: meta.id,
            relPath: task.relPath,
            mimeType: meta.mimeType,
            name: task.relPath.split('/').pop(),
            size: meta.size == null ? null : Number(meta.size),
            fileExtension: meta.fileExtension || '',
            shortcutDetails: null,
          });
        }
        scanned += 1;
      }

      if (send) {
        send('status', {
          phase: 'scanning',
          done: scanned,
          total: null,
          current: task.relPath,
          filesFound: out.length,
        });
      }
    })));

    current = next;
  }

  return out;
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
const FILE_META_FIELDS = 'id,name,mimeType,size,fileExtension,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)';

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
  if (isGoogleWorkspaceFile(file.mimeType)) {
    return {
      stream: null,
      size: null,
      exportExtension: '',
      exported: false,
      unsupported: true,
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

async function oneDriveItemExists(accessToken, oneDrivePath, signal) {
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
    return response.status === 200 && Boolean(response.data?.id);
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
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
      // A short/empty transfer here (most often 0 bytes uploaded) means the
      // Drive download stream ended early without ever raising a stream
      // 'error' — some connection resets surface as a clean-looking 'end'
      // instead of an error. Tag it so the per-file retry loop in the sync
      // route treats it the same as a network error and re-downloads the
      // file fresh, instead of permanently skipping it after one bad read.
      const mismatchErr = new Error(`Uploaded ${offset} bytes but expected ${sizeBytes}`);
      mismatchErr.code = 'EUPLOADMISMATCH';
      throw mismatchErr;
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

  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const syncController = new AbortController();
  let clientDisconnected = false;

  req.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      syncController.abort();
    }
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_INTERVAL_MS);

  const { items, destFolder } = req.body;
  const drive = getDriveClient(req.session.googleTokens);
  const dest = destFolder || 'DriveSync';

  try {
    send('status', {
      phase: 'scanning',
      done: 0,
      total: null,
      current: 'Scanning selected Google Drive folders…',
      filesFound: 0,
    });

    const flatFilesRaw = await collectDriveItems(
      drive,
      items || [],
      syncController.signal,
      send
    );

    // Deduplicate by Drive file ID while preserving distinct relative paths
    // for genuinely different files.
    const seenFiles = new Set();
    const flatFiles = [];
    for (const file of flatFilesRaw) {
      if (seenFiles.has(file.id)) continue;
      seenFiles.add(file.id);
      flatFiles.push(file);
    }

    send('start', { total: flatFiles.length });

    let done = 0;
    let skipped = 0;
    let existing = 0;

    const CONCURRENCY = 5;
    let nextIndex = 0;

    // Attempts one download+upload of a file and returns how it went,
    // instead of deciding done/skipped/existing itself — that lets the
    // caller retry the whole thing on a transient failure without
    // duplicating the "already handled, move on" bookkeeping.
    async function transferOneFile(file) {
      const originalMeta = await getResolvedFileMeta(
        drive,
        file.id,
        syncController.signal
      );

      if (!originalMeta) {
        return {
          outcome: 'skipped',
          reason: 'File no longer exists in Google Drive — skipped and continuing',
        };
      }

      const displayName = file.name || originalMeta.name;
      const oneDrivePathBase = `${dest}/${file.relPath}`;

      send('status', {
        done,
        total: flatFiles.length,
        current: file.relPath,
        phase: 'downloading',
      });

      const transfer = await getDriveFileStream(
        drive,
        {
          ...originalMeta,
          id: originalMeta.id,
          name: displayName,
        },
        syncController.signal
      );

      if (transfer.unsupported) {
        return { outcome: 'skipped', reason: transfer.unsupportedReason };
      }

      const accessToken = await ensureMsToken(req);
      let oneDrivePath = oneDrivePathBase;
      let stream = transfer.stream;
      let size = transfer.size;

      if (transfer.exportExtension) {
        if (!oneDrivePath.toLowerCase().endsWith(transfer.exportExtension)) {
          oneDrivePath += transfer.exportExtension;
        }
      }

      if (await oneDriveItemExists(accessToken, oneDrivePath, syncController.signal)) {
        return {
          outcome: 'skipped',
          existing: true,
          reason: 'Already exists in OneDrive — skipped',
        };
      }

      if (transfer.exportExtension) {
        const buffered = await bufferStream(stream, syncController.signal);
        stream = Readable.from(buffered.buffer);
        size = buffered.size;
      }

      send('status', {
        done,
        total: flatFiles.length,
        current: file.relPath,
        phase: 'uploading',
      });

      await uploadToOneDrive(
        accessToken,
        oneDrivePath,
        stream,
        size,
        syncController.signal
      );

      return { outcome: 'uploaded' };
    }

    async function worker() {
      while (true) {
        if (syncController.signal.aborted) throw new Error('Sync cancelled');

        const myIndex = nextIndex;
        if (myIndex >= flatFiles.length) return;
        nextIndex += 1;

        const file = flatFiles[myIndex];

        send('status', {
          done,
          total: flatFiles.length,
          current: file.relPath,
          phase: 'checking',
        });

        // A file gets a few full attempts (fresh download + fresh upload
        // each time) before it's marked skipped. Without this, one
        // transient hiccup — a dropped connection mid-download, a
        // byte-count mismatch from a truncated stream — permanently failed
        // the file on the very first try, which is why "Uploaded 0 bytes
        // but expected ..." and "connect ETIMEDOUT ..." showed up as
        // outright skips instead of being retried like a rate-limit is.
        const MAX_FILE_ATTEMPTS = 3;
        let result = null;
        let lastErr = null;

        for (let attempt = 1; attempt <= MAX_FILE_ATTEMPTS; attempt += 1) {
          try {
            result = await transferOneFile(file);
            lastErr = null;
            break;
          } catch (attemptErr) {
            if (syncController.signal.aborted || isAbortLike(attemptErr)) {
              throw new Error('Sync cancelled');
            }

            lastErr = attemptErr;

            const transient =
              isRetryableError(attemptErr) ||
              attemptErr.code === 'ESTALLED' ||
              attemptErr.code === 'EUPLOADMISMATCH';

            if (transient && attempt < MAX_FILE_ATTEMPTS) {
              console.warn(
                `Retrying ${file.relPath} (attempt ${attempt} failed):`,
                attemptErr.message
              );
              send('status', {
                done,
                total: flatFiles.length,
                current: file.relPath,
                phase: 'retrying',
              });
              await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
              continue;
            }

            break;
          }
        }

        if (lastErr) {
          done += 1;
          skipped += 1;

          console.warn(`Skipping ${file.relPath}:`, lastErr.message);

          send('progress', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            skipped: true,
            reason: lastErr.message,
          });
          continue;
        }

        done += 1;
        if (result.outcome === 'skipped') {
          skipped += 1;
          if (result.existing) existing += 1;
        }

        send('progress', {
          done,
          total: flatFiles.length,
          current: file.relPath,
          skipped: result.outcome === 'skipped',
          existing: Boolean(result.existing),
          reason: result.reason,
        });
      }
    }

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            CONCURRENCY,
            flatFiles.length
          ),
        },
        () => worker()
      )
    );

    send('complete', {
      done,
      total: flatFiles.length,
      skipped,
      existing,
    });

  } catch (err) {
    if (
      syncController.signal.aborted ||
      clientDisconnected ||
      isAbortLike(err)
    ) {
      if (!clientDisconnected) {
        send('cancelled', {
          message: 'Sync cancelled',
        });
      }

      console.log('Sync cancelled by client.');
    } else {
      console.error(
        'Sync error:',
        err.message
      );

      send('error', {
        message: err.message,
      });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
