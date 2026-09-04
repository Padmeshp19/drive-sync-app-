const express = require('express');
const { getDriveClient } = require('../auth/google');
const { createLimiter } = require('../utils/limiter');
const { isRetryableError } = require('../utils/retry');

const router = express.Router();

// How many Drive API calls we let run at once while walking a folder tree
// to total up a selection's size. This used to be strictly sequential
// (one folder awaited fully before the next started), which is why
// "Calculating..." could sit there for a long time on a selection with
// many nested folders — each subfolder's round trip blocked the next one.
const SIZE_CALC_CONCURRENCY = 8;

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

    // Also retry transient network failures (ETIMEDOUT, ENETUNREACH, a
    // dropped connection, etc.) — previously only 429/403 were retried, so
    // a one-off network blip permanently failed the request.
    if ((isRateLimited || isRetryableError(err)) && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return withBackoff(fn, retries - 1, delay * 2);
    }

    throw err;
  }
}

async function listChildren(drive, parentId, fields, pageToken = undefined) {
  const result = await withBackoff(() =>
    drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      spaces: 'drive',
      corpora: 'user',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: `nextPageToken, files(${fields})`,
      pageSize: 200,
      pageToken,
      orderBy: 'folder,name',
    })
  );

  return {
    files: result.data.files || [],
    nextPageToken: result.data.nextPageToken || null,
  };
}

async function listAllChildren(drive, parentId, fields) {
  const files = [];
  let pageToken;

  do {
    const page = await listChildren(drive, parentId, fields, pageToken);
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return files;
}

router.get('/list', requireGoogleAuth, async (req, res) => {
  const drive = getDriveClient(req.session.googleTokens);
  const parentId = req.query.parentId || 'root';

  try {
    const page = await listChildren(
      drive,
      parentId,
      'id, name, mimeType, size, modifiedTime',
      req.query.pageToken || undefined
    );
    const files = page.files;

    const mapped = files.map((file) => ({
      id: file.id,
      name: file.name,
      isFolder: file.mimeType === FOLDER_MIME,
      size: file.size || null,
      modifiedTime: file.modifiedTime,
    }));

    console.log(`Google Drive: found ${mapped.length} items in ${parentId}`);
    res.json({ files: mapped, nextPageToken: page.nextPageToken });
  } catch (err) {
    console.error('Drive list error:', err);

    res.status(500).json({
      error: 'Failed to list Drive files',
      detail: err.message,
      code: err.code || err.response?.status || null,
    });
  }
});

async function collectFolderStats(drive, folderId, stats, visited, limit) {
  if (visited.has(folderId)) return;
  visited.add(folderId);

  const children = await listAllChildren(
    drive,
    folderId,
    'id, name, mimeType, size'
  );

  const subfolders = [];

  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      subfolders.push(child);
      continue;
    }

    if (stats.files.has(child.id)) continue;

    stats.files.set(child.id, {
      name: child.name,
      size: child.size == null ? null : Number(child.size),
    });
  }

  // Recurse into subfolders concurrently (bounded by `limit`) instead of
  // awaiting each one before starting the next.
  await Promise.all(
    subfolders.map((child) =>
      limit(() => collectFolderStats(drive, child.id, stats, visited, limit))
    )
  );
}

router.post('/trash', requireGoogleAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (items.length === 0) {
    return res.status(400).json({
      error: 'No items selected',
      detail: 'Select at least one file or folder to move to Trash.',
    });
  }

  const drive = getDriveClient(req.session.googleTokens);
  const results = [];

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;

    try {
      const result = await withBackoff(() =>
        drive.files.update({
          fileId: item.id,
          requestBody: { trashed: true },
          supportsAllDrives: true,
          fields: 'id, name, trashed',
        })
      );

      results.push({
        id: item.id,
        name: result.data.name || item.name || 'Unnamed item',
        trashed: result.data.trashed === true,
        success: true,
      });
    } catch (err) {
      console.error(`Drive trash error for ${item.id}:`, err.message);
      results.push({
        id: item.id,
        name: item.name || 'Unnamed item',
        success: false,
        error: err.message,
        code: err.code || err.response?.status || null,
      });
    }
  }

  const failed = results.filter((item) => !item.success);
  const succeeded = results.filter((item) => item.success);

  res.json({
    success: failed.length === 0,
    trashed: succeeded.length,
    failed: failed.length,
    results,
  });
});


router.get('/search', requireGoogleAuth, async (req, res) => {
  const drive = getDriveClient(req.session.googleTokens);
  const term = String(req.query.q || '').trim();
  const pageToken = req.query.pageToken || undefined;

  if (!term) {
    return res.json({ files: [], nextPageToken: null });
  }

  if (term.length > 200) {
    return res.status(400).json({
      error: 'Search text is too long',
      detail: 'Keep the search to 200 characters or fewer.',
    });
  }

  // Escape characters that have special meaning inside a Google Drive query string.
  const escapedTerm = term.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  try {
    const result = await withBackoff(() =>
      drive.files.list({
        q: `name contains '${escapedTerm}' and trashed = false`,
        spaces: 'drive',
        corpora: 'user',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
        pageSize: 100,
        pageToken,
        orderBy: 'folder,name',
      })
    );

    const files = (result.data.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      isFolder: file.mimeType === FOLDER_MIME,
      size: file.size || null,
      modifiedTime: file.modifiedTime,
    }));

    console.log(`Google Drive search: "${term}" found ${files.length} items`);
    res.json({ files, nextPageToken: result.data.nextPageToken || null });
  } catch (err) {
    console.error('Drive search error:', err);
    res.status(500).json({
      error: 'Failed to search Drive',
      detail: err.message,
      code: err.code || err.response?.status || null,
    });
  }
});

router.post('/selection-size', requireGoogleAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (items.length === 0) {
    return res.json({
      totalBytes: 0,
      fileCount: 0,
      unknownSizeCount: 0,
    });
  }

  const drive = getDriveClient(req.session.googleTokens);
  const stats = { files: new Map() };
  const visitedFolders = new Set();
  const limit = createLimiter(SIZE_CALC_CONCURRENCY);

  try {
    // Kick off every top-level item's stat collection concurrently (bounded
    // by the same limiter that governs the recursive folder walk below),
    // rather than fully resolving one selected item before starting the next.
    await Promise.all(
      items
        .filter((item) => item && typeof item.id === 'string' && item.id)
        .map((item) =>
          limit(async () => {
            if (item.isFolder) {
              await collectFolderStats(drive, item.id, stats, visitedFolders, limit);
              return;
            }

            const result = await withBackoff(() =>
              drive.files.get({
                fileId: item.id,
                fields: 'id, name, mimeType, size',
                supportsAllDrives: true,
              })
            );

            if (result.data.mimeType === FOLDER_MIME) {
              await collectFolderStats(drive, item.id, stats, visitedFolders, limit);
            } else {
              stats.files.set(item.id, {
                name: result.data.name,
                size: result.data.size == null ? null : Number(result.data.size),
              });
            }
          })
        )
    );

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
