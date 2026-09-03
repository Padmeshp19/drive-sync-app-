const { google } = require('googleapis');

// Full Drive access is required for moving user-selected files/folders to Trash.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function getTokensFromCode(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

function getDriveClient(tokens) {
  const client = getOAuthClient();
  client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: client });
}

module.exports = { getAuthUrl, getTokensFromCode, getDriveClient, getOAuthClient };
