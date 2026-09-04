// Google Drive sync: unsupported/non-downloadable Drive items are preserved as .url shortcuts when a Drive link is available.
const express = require('express');
const axios = require('axios');
const { getDriveClient } = require('../auth/google');
const { refreshTokens } = require('../auth/microsoft');
const { Readable } = require('stream');

const router = express.Router();

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

async function walkDrive(drive, fileId, isFolder, relPath, out, visitedFolders = new Set(), signal = null) {
  if (signal?.aborted) throw new Error('Sync cancelled');

  if (!isFolder) {
    const meta = await getResolvedFileMeta(drive, fileId, signal);
    if (meta.mimeType === FOLDER_MIME) {
      return walkDrive(drive, meta.id, true, relPath, out, visitedFolders, signal);
    }
    out.push({
      id: meta.id,
      relPath,
      mimeType: meta.mimeType,
      name: relPath.split('/').pop(),
      size: meta.size == null ? null : Number(meta.size),
      fileExtension: meta.fileExtension || '',
      shortcutDetails: null,
      webViewLink: meta.webViewLink || '',
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

    for (const child of res.data.files || []) {
      if (signal?.aborted) throw new Error('Sync cancelled');

      const isShortcut = child.mimeType === SHORTCUT_MIME;
      const targetMimeType = child.shortcutDetails?.targetMimeType || '';
      const shortcutTargetId = child.shortcutDetails?.targetId || '';

      // A shortcut to a folder must be traversed through the TARGET folder ID.
      // Walking the shortcut ID itself returns no children and eventually causes
      // the shortcut to be treated like a non-downloadable binary file.
      if (isShortcut && shortcutTargetId) {
        const targetMeta = await getResolvedFileMeta(drive, shortcutTargetId, signal);

        if (targetMeta.mimeType === FOLDER_MIME || targetMimeType === FOLDER_MIME) {
          await walkDrive(
            drive,
            targetMeta.id,
            true,
            `${relPath}/${child.name}`,
            out,
            visitedFolders,
            signal
          );
          continue;
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
          webViewLink: targetMeta.webViewLink || '',
        });
        continue;
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
          signal
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
          webViewLink: child.webViewLink || '',
        });
      }
    }

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

async function getResolvedFileMeta(drive, fileId, signal, seen = new Set()) {
  if (seen.has(fileId)) throw new Error('Shortcut cycle detected');
  if (seen.size > 8) throw new Error('Shortcut chain is too deep');
  seen.add(fileId);

  const response = await withBackoff(() => drive.files.get({
    fileId,
    fields: FILE_META_FIELDS,
    supportsAllDrives: true,
  }), 5, 500, signal);

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

function createInternetShortcutBuffer(name, url) {
  const safeName = String(name || 'Google Drive item').trim() || 'Google Drive item';
  const safeUrl = String(url || '').trim();
  const content = `[InternetShortcut]\r\nURL=${safeUrl}\r\n`;
  return Buffer.from(content, 'utf8');
}

function withUrlExtension(name) {
  return String(name || 'Google Drive item').toLowerCase().endsWith('.url')
    ? String(name || 'Google Drive item')
    : `${String(name || 'Google Drive item')}.url`;
}

async function getDriveFileStream(drive, file, signal) {
  const exportInfo = getExportInfo(file.mimeType);

  if (exportInfo) {
    const response = await withBackoff(() => drive.files.export(
      { fileId: file.id, mimeType: exportInfo.mimeType },
      { responseType: 'stream', signal }
    ), 5, 500, signal);

    return {
      stream: response.data,
      size: null,
      exportExtension: exportInfo.extension,
      exported: true,
    };
  }

  // Some Google Drive items (for example third-party shortcuts or certain
  // Workspace types) are metadata-only and cannot be downloaded/exported.
  // Preserve them as clickable .url files instead of losing them. Google
  // documents that third-party shortcuts cannot be uploaded/downloaded as
  // content, so a link file is the safe one-shot fallback.
  if (isGoogleWorkspaceFile(file.mimeType)) {
    if (file.webViewLink) {
      return {
        stream: null,
        size: 0,
        exportExtension: '',
        exported: false,
        unsupported: false,
        linkOnly: true,
        linkUrl: file.webViewLink,
        linkName: withUrlExtension(file.name),
      };
    }

    return {
      stream: null,
      size: null,
      exportExtension: '',
      exported: false,
      unsupported: true,
      unsupportedReason: `Google Drive item type ${file.mimeType} has no downloadable content or Drive link`,
    };
  }

  if (file.capabilities && file.capabilities.canDownload === false) {
    if (file.webViewLink) {
      return {
        stream: null,
        size: 0,
        exportExtension: '',
        exported: false,
        unsupported: false,
        linkOnly: true,
        linkUrl: file.webViewLink,
        linkName: withUrlExtension(file.name),
      };
    }

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
      stream: response.data,
      size: file.size == null ? null : Number(file.size),
      exportExtension: '',
      exported: false,
      unsupported: false,
    };
  } catch (err) {
    // A metadata-only Google item should never crash the entire batch.
    if (isFileNotDownloadableError(err)) {
      if (file.webViewLink) {
        return {
          stream: null,
          size: 0,
          exportExtension: '',
          exported: false,
          unsupported: false,
          linkOnly: true,
          linkUrl: file.webViewLink,
          linkName: withUrlExtension(file.name),
        };
      }

      return {
        stream: null,
        size: null,
        exportExtension: '',
        exported: false,
        unsupported: true,
        unsupportedReason: 'Google Drive reported this item as not downloadable and no Drive link was available',
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
    const chunkSize = 5 * 1024 * 1024;
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
        timeout: 120000,
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

  const { items, destFolder } = req.body;
  const drive = getDriveClient(req.session.googleTokens);
  const dest = destFolder || 'DriveSync';

  try {
    const flatFiles = [];
    const seenFiles = new Set();

    for (const item of items || []) {
      if (syncController.signal.aborted) throw new Error('Sync cancelled');
      const collected = [];
      await walkDrive(drive, item.id, item.isFolder, item.name, collected, new Set(), syncController.signal);

      for (const file of collected) {
        if (seenFiles.has(file.id)) continue;
        seenFiles.add(file.id);
        flatFiles.push(file);
      }
    }

    send('start', { total: flatFiles.length });

    let done = 0;
    let skipped = 0;
    let existing = 0;

    for (const file of flatFiles) {
      if (syncController.signal.aborted) throw new Error('Sync cancelled');

      try {
        send('status', { done, total: flatFiles.length, current: file.relPath, phase: 'checking' });
        const originalMeta = await getResolvedFileMeta(drive, file.id, syncController.signal);
        const displayName = file.name || originalMeta.name;
        const oneDrivePathBase = `${dest}/${file.relPath}`;

        send('status', { done, total: flatFiles.length, current: file.relPath, phase: 'downloading' });
        const transfer = await getDriveFileStream(drive, {
          ...originalMeta,
          id: originalMeta.id,
          name: displayName,
        }, syncController.signal);

        if (transfer.unsupported) {
          done += 1;
          skipped += 1;
          send('progress', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            skipped: true,
            reason: transfer.unsupportedReason,
          });
          continue;
        }

        const accessToken = await ensureMsToken(req);
        let oneDrivePath = oneDrivePathBase;
        let stream = transfer.stream;
        let size = transfer.size;

        if (transfer.linkOnly) {
          oneDrivePath = `${dest}/${file.relPath}.url`;
          if (await oneDriveItemExists(accessToken, oneDrivePath, syncController.signal)) {
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

          const linkBuffer = createInternetShortcutBuffer(
            file.name,
            transfer.linkUrl || originalMeta.webViewLink
          );

          stream = Readable.from(linkBuffer);
          size = linkBuffer.length;

          send('status', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            phase: 'saving-link',
          });

          await uploadToOneDrive(
            accessToken,
            oneDrivePath,
            stream,
            size,
            syncController.signal
          );

          done += 1;
          send('progress', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            skipped: false,
            linked: true,
          });
          continue;
        }

        if (transfer.exportExtension) {
          if (!oneDrivePath.toLowerCase().endsWith(transfer.exportExtension)) {
            oneDrivePath += transfer.exportExtension;
          }
        }

        // Resume-safe behavior: never upload the same destination path twice.
        // This makes a cancelled sync safe to run again.
        if (await oneDriveItemExists(accessToken, oneDrivePath, syncController.signal)) {
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

        // Only export/buffer after confirming the destination is missing.
        if (transfer.exportExtension) {
          const buffered = await bufferStream(stream, syncController.signal);
          stream = Readable.from(buffered.buffer);
          size = buffered.size;
        }

        send('status', { done, total: flatFiles.length, current: file.relPath, phase: 'uploading' });
        await uploadToOneDrive(accessToken, oneDrivePath, stream, size, syncController.signal);
        done += 1;
        send('progress', { done, total: flatFiles.length, current: file.relPath, skipped: false });
      } catch (fileErr) {
        if (syncController.signal.aborted || isAbortLike(fileErr)) throw new Error('Sync cancelled');

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

    send('complete', { done, total: flatFiles.length, skipped, existing });
  } catch (err) {
    if (syncController.signal.aborted || clientDisconnected || isAbortLike(err)) {
      if (!clientDisconnected) send('cancelled', { message: 'Sync cancelled' });
      console.log('Sync cancelled by client.');
    } else {
      console.error('Sync error:', err.message);
      send('error', { message: err.message });
    }
  } finally {
    res.end();
  }
});

module.exports = router;
