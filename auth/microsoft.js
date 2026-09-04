const axios = require('axios');

const SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read'];
const TENANT = process.env.MS_TENANT || 'common';

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MS_REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES.join(' '),
  });
  return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function getTokensFromCode(code) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.MS_REDIRECT_URI,
  });
  const { data } = await axios.post(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 }
  );
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshTokens(refreshToken, signal = null) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
  // Previously had no timeout at all, so if this host's route to
  // login.microsoftonline.com was blackholed (same connectivity class as
  // the ETIMEDOUT/ENETUNREACH errors seen elsewhere against Graph), the
  // call would hang for minutes on the OS's own TCP timeout with nothing
  // surfaced to the sync — which is exactly what "stuck with no error"
  // looks like, since every file needing a fresh token blocks on it.
  const { data } = await axios.post(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000, signal }
  );
  return data;
}

module.exports = { getAuthUrl, getTokensFromCode, refreshTokens };
