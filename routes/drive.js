const express = require('express');
const { getDriveClient } = require('../auth/google');

const router = express.Router();

function requireGoogleAuth(req, res, next) {
  if (!req.session.googleTokens) {
    return res.status(401).json({ error: 'Not authenticated with Google' });
  }
  next();
}

// Retry wrapper: Drive API returns 403/429 on rate limit. Exponential backoff.
async function withBackoff(fn, retries = 5, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    const code = err.code || err.response?.status;
    const isRateLimited = code === 429 || code === 403;
    if (isRateLimited && retries > 0) {
      await new Promise((r) => setTimeout(r, delay));
      return withBackoff(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

// List children of a folder (or root if no parentId given)
router.get('/list', requireGoogleAuth, async (req, res) => {
  const drive = getDriveClient(req.session.googleTokens);
  const parentId = req.query.parentId || 'root';

  try {
    const result = await withBackoff(() =>
      drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, size, modifiedTime)',
        pageSize: 200,
        orderBy: 'folder,name',
      })
    );
    const files = result.data.files.map((f) => ({
      id: f.id,
      name: f.name,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
      size: f.size || null,
      modifiedTime: f.modifiedTime,
    }));
    res.json({ files });
  } catch (err) {
    console.error('Drive list error:', err.message);
    res.status(500).json({ error: 'Failed to list Drive files', detail: err.message });
  }
});

module.exports = router;
