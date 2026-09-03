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

// Recursively walk a Drive folder, collecting a flat file list with relative paths
async function walkDrive(drive, fileId, isFolder, relPath, out) {
  if (!isFolder) {
    out.push({ id: fileId, relPath });
    return;
  }
  const res = await withBackoff(() =>
    drive.files.list({
      q: `'${fileId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1000,
    })
  );
  for (const child of res.data.files) {
    const childIsFolder = child.mimeType === 'application/vnd.google-apps.folder';
    await walkDrive(drive, child.id, childIsFolder, `${relPath}/${child.name}`, out);
  }
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
    for (const item of items) {
      await walkDrive(drive, item.id, item.isFolder, item.name, flatFiles);
    }
    send('start', { total: flatFiles.length });

    let done = 0;
    for (const file of flatFiles) {
      const accessToken = await ensureMsToken(req);
      const meta = await withBackoff(() =>
        drive.files.get({ fileId: file.id, fields: 'name, size, mimeType' })
      );
      const dlStream = await withBackoff(() =>
        drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' })
      );
      const oneDrivePath = `${dest}/${file.relPath}`;
      await uploadToOneDrive(accessToken, oneDrivePath, dlStream.data, Number(meta.data.size));
      done += 1;
      send('progress', { done, total: flatFiles.length, current: file.relPath });
    }
    send('complete', { done, total: flatFiles.length });
  } catch (err) {
    console.error('Sync error:', err.message);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;
