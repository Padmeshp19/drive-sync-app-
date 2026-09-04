# Drive → OneDrive Sync

A small full-stack app that lets you browse your Google Drive, pick specific
folders/files with checkboxes, and sync them into a chosen folder in your
OneDrive — with live progress and rate-limit-safe retries on both APIs.

## Stack
- Node.js + Express
- Google Drive API v3 (OAuth2, read-only scope)
- Microsoft Graph API (OAuth2, `Files.ReadWrite`)
- Vanilla JS frontend, no build step
- Server-Sent Events for live sync progress

## Setup

### 1. Google Cloud Console
1. Create a project → enable **Google Drive API**.
2. Create OAuth 2.0 credentials (Web application).
3. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
4. Copy the client ID/secret into `.env`.

### 2. Azure Portal
1. **App registrations** → New registration (any account types is fine for personal testing).
2. Add redirect URI: `http://localhost:3000/auth/microsoft/callback` (type: Web).
3. **API permissions** → add **Files.ReadWrite** (Microsoft Graph, delegated) → grant consent.
4. **Certificates & secrets** → new client secret → copy the value (not the ID).
5. Copy the application (client) ID and secret into `.env`.

### 3. Install & run
```bash
cp .env.example .env
# fill in .env with the values above
npm install
npm start
```
Visit `http://localhost:3000`, connect both accounts, browse, check the
items you want, and hit Sync.

## How rate limits are handled
- Every Drive and Graph call goes through an exponential-backoff wrapper
  that retries on `429`/`403`(Drive)/`503`(Graph), honoring `Retry-After`
  headers when present.
- Files over 4MB use Graph's resumable upload session (chunked PUT) instead
  of the simple-upload endpoint, which has a strict 4MB cap.
- Microsoft access tokens are refreshed proactively before they expire
  (~1hr lifetime) so a long sync doesn't get cut off mid-run.

## Known limitations (good next steps for the portfolio writeup)
- Files are buffered in memory before upload rather than true streaming
  chunk-by-chunk — fine for typical files, not ideal for very large ones.
- No persistent storage — tokens live in the session, so restarting the
  server means reconnecting both accounts.
- No conflict detection beyond "replace" on the OneDrive side.
