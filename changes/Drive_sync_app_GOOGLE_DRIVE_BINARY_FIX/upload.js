const express = require('express');
const axios = require('axios');
const { getDriveClient } = require('../auth/google');
const { refreshTokens } = require('../auth/microsoft');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  if (!req.session.msTokens) return res.status(401).json({ error: 'Not authenticated with Microsoft' });
  next();
}

async function withBackoff(fn, retries = 5, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    const status = err.response?.status || err.code;
    if ((status === 429 || status === 503) && retries > 0) {
      const retryAfter = err.response?.headers?.['retry-after'];
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
      await new Promise((r) => setTimeout(r, wait));
      return withBackoff(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

async function ensureMsToken(req) {
  // Refresh proactively; Graph tokens are short-lived (~1hr)
  const tokens = req.session.msTokens;
  if (Date.now() < (tokens.obtainedAt + tokens.expires_in * 1000) - 60000) {
    return tokens.access_token;
  }
  const fresh = await refreshTokens(tokens.refresh_token);
  req.session.msTokens = { ...fresh, obtainedAt: Date.now() };
  return fresh.access_token;
}

// Recursively walk a Drive folder, collecting a flat file list with relative paths.
// Pagination is handled so folders with more than one page of children are complete.
async function walkDrive(drive, fileId, isFolder, relPath, out, visitedFolders = new Set()) {
  if (!isFolder) {
    out.push({ id: fileId, relPath, mimeType: null });
    return;
  }

  if (visitedFolders.has(fileId)) return;
  visitedFolders.add(fileId);

  let pageToken;

  do {
    const res = await withBackoff(() =>
      drive.files.list({
        q: `'${fileId}' in parents and trashed = false`,
        spaces: 'drive',
        corpora: 'user',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 1000,
        pageToken,
        orderBy: 'folder,name',
      })
    );

    for (const child of res.data.files || []) {
      const childIsFolder = child.mimeType === 'application/vnd.google-apps.folder';
      const before = out.length;
      await walkDrive(
        drive,
        child.id,
        childIsFolder,
        `${relPath}/${child.name}`,
        out,
        visitedFolders
      );
      if (!childIsFolder) {
        for (let i = before; i < out.length; i += 1) {
          out[i].mimeType = child.mimeType;
        }
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

function getExportInfo(mimeType) {
  return GOOGLE_EXPORTS[mimeType] || null;
}

function isGoogleWorkspaceFile(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('application/vnd.google-apps.');
}

// Some Drive items can expose an unusual MIME type even though their names
// clearly identify them as ordinary binary files (for example PDF/ZIP).
// Never classify a normal downloadable extension as an unsupported Workspace
// document just because the MIME type is unexpected.
const BINARY_EXTENSIONS = new Set([
  '.zip', '.pdf', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg',
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.webm', '.m4v',
  '.exe', '.msi', '.dmg', '.iso', '.apk', '.deb', '.rpm',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf',
]);

function hasKnownBinaryExtension(name) {
  const lower = String(name || '').toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

async function getDriveFileStream(drive, file) {
  const exportInfo = getExportInfo(file.mimeType);

  if (exportInfo) {
    const response = await withBackoff(() =>
      drive.files.export(
        { fileId: file.id, mimeType: exportInfo.mimeType },
        { responseType: 'stream' }
      )
    );
    return {
      stream: response.data,
      size: null,
      exportExtension: exportInfo.extension,
      exported: true,
    };
  }

  // Google Workspace files that are not in GOOGLE_EXPORTS cannot be downloaded
  // with alt=media. Returning a clear skip signal prevents one such file from
  // aborting an otherwise valid Drive sync.
  if (isGoogleWorkspaceFile(file.mimeType) && !hasKnownBinaryExtension(file.name)) {
    return {
      stream: null,
      size: null,
      exportExtension: '',
      exported: false,
      unsupported: true,
    };
  }

  const response = await withBackoff(() =>
    drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'stream' }
    )
  );

  return {
    stream: response.data,
    size: file.size == null ? null : Number(file.size),
    exportExtension: '',
    exported: false,
    unsupported: false,
  };
}

async function bufferStream(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
  }
  return { buffer: Buffer.concat(chunks, size), size };
}

// Upload one file's bytes into OneDrive at the given path. Uses resumable
// upload session for anything over 4MB (Graph's simple-upload limit).
async function uploadToOneDrive(accessToken, oneDrivePath, stream, sizeBytes) {
  const encodedPath = oneDrivePath.split('/').map(encodeURIComponent).join('/');

  if (sizeBytes && sizeBytes > 4 * 1024 * 1024) {
    const sessionRes = await withBackoff(() =>
      axios.post(
        `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/createUploadSession`,
        { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
    );
    const uploadUrl = sessionRes.data.uploadUrl;
    const chunkSize = 5 * 1024 * 1024; // 5MB, must be multiple of 320KB
    let offset = 0;
    let accumulator = Buffer.alloc(0);

    for await (const chunk of stream) {
      accumulator = Buffer.concat([accumulator, chunk]);
      while (accumulator.length >= chunkSize) {
        const slice = accumulator.subarray(0, chunkSize);
        accumulator = accumulator.subarray(chunkSize);
        await withBackoff(() =>
          axios.put(uploadUrl, slice, {
            headers: {
              'Content-Length': slice.length,
              'Content-Range': `bytes ${offset}-${offset + slice.length - 1}/${sizeBytes}`,
            },
          })
        );
        offset += slice.length;
      }
    }

    // Upload the remaining data (if any) as the final chunk
    if (accumulator.length > 0) {
      await withBackoff(() =>
        axios.put(uploadUrl, accumulator, {
          headers: {
            'Content-Length': accumulator.length,
            'Content-Range': `bytes ${offset}-${offset + accumulator.length - 1}/${sizeBytes}`,
          },
        })
      );
      offset += accumulator.length;
    }

    // Verify we uploaded the expected number of bytes
    if (offset !== sizeBytes) {
      throw new Error(`Uploaded ${offset} bytes but expected ${sizeBytes}`);
    }
  } else {
    // For small files, we still need to buffer the entire content because the simple upload endpoint
    // requires the complete file in a single request. However, we avoid storing an array of chunks.
    let accumulator = Buffer.alloc(0);
    for await (const chunk of stream) {
      accumulator = Buffer.concat([accumulator, chunk]);
    }
    await withBackoff(() =>
      axios.put(
        `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/content`,
        accumulator,
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' } }
      )
    );
  }
}

// POST /upload/sync  { items: [{ id, name, isFolder }], destFolder: "DriveSync" }
// Streams progress back over SSE.
router.post('/sync', requireAuth, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const { items, destFolder } = req.body;
  const drive = getDriveClient(req.session.googleTokens);
  const dest = destFolder || 'DriveSync';

  try {
    const flatFiles = [];
    const seenFiles = new Set();

    for (const item of items) {
      const collected = [];
      await walkDrive(drive, item.id, item.isFolder, item.name, collected);

      for (const file of collected) {
        // If the user selects both a folder and one of its children, do not sync
        // the same Drive file twice.
        if (seenFiles.has(file.id)) continue;
        seenFiles.add(file.id);
        flatFiles.push(file);
      }
    }

    send('start', { total: flatFiles.length });

    let done = 0;
    let skipped = 0;
    for (const file of flatFiles) {
      try {
        const meta = await withBackoff(() =>
          drive.files.get({
            fileId: file.id,
            fields: 'name, size, mimeType, fileExtension',
            supportsAllDrives: true,
          })
        );

        const oneDrivePathBase = `${dest}/${file.relPath}`;
        const transfer = await getDriveFileStream(drive, {
          id: file.id,
          name: meta.data.name || file.relPath.split('/').pop(),
          mimeType: meta.data.mimeType,
          size: meta.data.size == null ? null : Number(meta.data.size),
        });

        if (transfer.unsupported) {
          done += 1;
          skipped += 1;
          send('progress', {
            done,
            total: flatFiles.length,
            current: file.relPath,
            skipped: true,
            reason: 'Google Workspace file has no supported Drive export format',
          });
          continue;
        }

        const accessToken = await ensureMsToken(req);
        let oneDrivePath = oneDrivePathBase;
        let stream = transfer.stream;
        let size = transfer.size;

        // Exports are streamed without a known Content-Length. Buffer the export
        // once so OneDrive gets the exact byte count and large exports use an
        // upload session instead of Graph's small-file endpoint.
        if (transfer.exportExtension) {
          const buffered = await bufferStream(stream);
          stream = require('stream').Readable.from(buffered.buffer);
          size = buffered.size;
          if (!oneDrivePath.toLowerCase().endsWith(transfer.exportExtension)) {
            oneDrivePath += transfer.exportExtension;
          }
        }

        await uploadToOneDrive(accessToken, oneDrivePath, stream, size);
        done += 1;
        send('progress', { done, total: flatFiles.length, current: file.relPath });
      } catch (fileErr) {
        // A single bad/unsupported Drive item should not stop the rest of the
        // selection. Surface it as a skipped item and continue syncing.
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
    send('complete', { done, total: flatFiles.length, skipped });
  } catch (err) {
    console.error('Sync error:', err.message);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;
