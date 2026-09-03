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

async function countStreamBytes(stream) {
  let total = 0;
  for await (const chunk of stream) {
    total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
  }
  return total;
}

async function getTransferInfo(drive, file) {
  if (file.size != null && Number.isFinite(Number(file.size))) {
    return {
      size: Number(file.size),
      exported: false,
      exportMimeType: null,
      exportExtension: '',
    };
  }

  const exportInfo = getExportInfo(file.mimeType);
  if (!exportInfo) {
    return {
      size: null,
      exported: false,
      exportMimeType: null,
      exportExtension: '',
    };
  }

  const exported = await withBackoff(() =>
    drive.files.export(
      {
        fileId: file.id,
        mimeType: exportInfo.mimeType,
      },
      { responseType: 'stream' }
    )
  );

  const size = await countStreamBytes(exported.data);
  return {
    size,
    exported: true,
    exportMimeType: exportInfo.mimeType,
    exportExtension: exportInfo.extension,
  };
}

async function collectFolderStats(drive, folderId, stats, visited) {
  if (visited.has(folderId)) return;
  visited.add(folderId);

  const children = await listAllChildren(
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
      id: child.id,
      name: child.name,
      mimeType: child.mimeType,
      size: child.size == null ? null : Number(child.size),
    });
  }
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
      exportedCount: 0,
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
            id: item.id,
            name: result.data.name,
            mimeType: result.data.mimeType,
            size: result.data.size == null ? null : Number(result.data.size),
          });
        }
      }
    }

    let totalBytes = 0;
    let unknownSizeCount = 0;
    let exportedCount = 0;
    const files = Array.from(stats.files.values());

    // Export Google-native files so their actual OneDrive transfer size is counted.
    // A small concurrency limit keeps large selections responsive without hammering Drive.
    const concurrency = 3;
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= files.length) return;

        const file = files[index];
        try {
          const transfer = await getTransferInfo(drive, file);

          if (Number.isFinite(transfer.size)) {
            totalBytes += transfer.size;
            if (transfer.exported) exportedCount += 1;
          } else {
            unknownSizeCount += 1;
          }
        } catch (fileErr) {
          // One unsupported/too-large Google-native export should not make the
          // whole selection size fail. Keep that file in the unknown bucket.
          console.warn(`Could not determine transfer size for ${file.id}:`, fileErr.message);
          unknownSizeCount += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

    res.json({
      totalBytes,
      fileCount: stats.files.size,
      unknownSizeCount,
      exportedCount,
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
