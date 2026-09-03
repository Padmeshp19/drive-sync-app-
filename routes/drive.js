const express = require('express');
const { getDriveClient } = require('../auth/google');

const router = express.Router();

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function requireGoogleAuth(req, res, next) {
  if (!req.session.googleTokens) {
    return res.status(401).json({
      error: 'Not authenticated with Google',
    });
  }
  next();
}

async function withBackoff(fn, retries = 5, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    const code = err.code || err.response?.status;
    const isRateLimited = code === 429 || code === 403;

    if (isRateLimited && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return withBackoff(fn, retries - 1, delay * 2);
    }

    throw err;
  }
}

async function listChildren(drive, parentId, fields) {
  const files = [];
  let pageToken;

  do {
    const result = await withBackoff(() =>
      drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        spaces: 'drive',
        corpora: 'user',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: `nextPageToken, files(${fields})`,
        pageSize: 1000,
        pageToken,
        orderBy: 'folder,name',
      })
    );

    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken;
  } while (pageToken);

  return files;
}

router.get('/list', requireGoogleAuth, async (req, res) => {
  const drive = getDriveClient(req.session.googleTokens);
  const parentId = req.query.parentId || 'root';

  try {
    const files = await listChildren(
      drive,
      parentId,
      'id, name, mimeType, size, modifiedTime'
    );

    const mapped = files.map((file) => ({
      id: file.id,
      name: file.name,
      isFolder: file.mimeType === FOLDER_MIME,
      size: file.size || null,
      modifiedTime: file.modifiedTime,
    }));

    console.log(`Google Drive: found ${mapped.length} items in ${parentId}`);
    res.json({ files: mapped });
  } catch (err) {
    console.error('Drive list error:', err);

    res.status(500).json({
      error: 'Failed to list Drive files',
      detail: err.message,
      code: err.code || err.response?.status || null,
    });
  }
});

async function collectFolderStats(drive, folderId, stats, visited) {
  if (visited.has(folderId)) return;
  visited.add(folderId);

  const children = await listChildren(
    drive,
    folderId,
    'id, name, mimeType, size'
  );

  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      await collectFolderStats(drive, child.id, stats, visited);
      continue;
    }

    if (stats.files.has(child.id)) continue;

    stats.files.set(child.id, {
      name: child.name,
      size: child.size == null ? null : Number(child.size),
    });
  }
}

router.post('/selection-size', requireGoogleAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (items.length === 0) {
    return res.json({
      totalBytes: 0,
      fileCount: 0,
      unknownSizeCount: 0,
    });
  }

  if (items.length > 100) {
    return res.status(400).json({
      error: 'Too many selected items',
      detail: 'Select 100 items or fewer at a time.',
    });
  }

  const drive = getDriveClient(req.session.googleTokens);
  const stats = { files: new Map() };
  const visitedFolders = new Set();

  try {
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;

      if (item.isFolder) {
        await collectFolderStats(drive, item.id, stats, visitedFolders);
      } else {
        const result = await withBackoff(() =>
          drive.files.get({
            fileId: item.id,
            fields: 'id, name, mimeType, size',
            supportsAllDrives: true,
          })
        );

        if (result.data.mimeType === FOLDER_MIME) {
          await collectFolderStats(drive, item.id, stats, visitedFolders);
        } else {
          stats.files.set(item.id, {
            name: result.data.name,
            size: result.data.size == null ? null : Number(result.data.size),
          });
        }
      }
    }

    let totalBytes = 0;
    let unknownSizeCount = 0;

    for (const file of stats.files.values()) {
      if (Number.isFinite(file.size)) {
        totalBytes += file.size;
      } else {
        unknownSizeCount += 1;
      }
    }

    res.json({
      totalBytes,
      fileCount: stats.files.size,
      unknownSizeCount,
    });
  } catch (err) {
    console.error('Drive selection size error:', err);

    res.status(500).json({
      error: 'Failed to calculate selection size',
      detail: err.message,
      code: err.code || err.response?.status || null,
    });
  }
});

module.exports = router;
