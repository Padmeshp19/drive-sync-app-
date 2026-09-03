# Drive Sync App - Deployment Guide

This guide will help you deploy the Drive → OneSync app online so you can access it from anywhere.

## 📋 Prerequisites

Before deploying, you need to have:
1. **Google Cloud Console** project with Google Drive API enabled
2. **Azure Portal** app registration with Microsoft Graph API permissions
3. Basic familiarity with deploying Node.js applications

## 🔑 Step 1: Get Your API Credentials

### Google Drive API
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/select a project
3. Enable **Google Drive API** for your project
4. Go to **APIs & Services → Credentials**
5. Create **OAuth 2.0 Client ID** (Application type: Web application)
6. Note down your **Client ID** and **Client Secret**

### Microsoft Graph API (OneDrive)
1. Go to [Azure Portal](https://portal.azure.com/)
2. Go to **Azure Active Directory → App registrations → New registration**
3. Name your app (e.g., "Drive Sync App")
4. Supported account types: **Accounts in any organizational directory (Any Azure AD directory - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**
5. Redirect URI: We'll set this after deployment
6. After registration, go to **Certificates & secrets → New client secret**
7. Copy the **client secret value** (you won't see it again!)
8. Go to **API permissions → Add permission → Microsoft Graph → Delegated permissions**
9. Add **Files.ReadWrite.All** (or Files.ReadWrite for basic access)
10. Click **Grant admin consent**
11. Note down your **Application (client) ID** and **client secret**

## 🌐 Step 2: Choose Your Deployment Platform

### Option A: Render.com (Recommended)
1. Sign up at [render.com](https://render.com)
2. Click **New + → Web Service**
3. Connect your GitHub/GitLab repository (or click "Deploy a public GitHub repository" and enter this repo URL)
4. Render will auto-detect it's a Node.js app
5. In the **Environment** section, add these environment variables:
   - `GOOGLE_CLIENT_ID`: [Your Google Client ID]
   - `GOOGLE_CLIENT_SECRET`: [Your Google Client Secret]
   - `GOOGLE_REDIRECT_URI`: `https://your-service-name.onrender.com/auth/google/callback`
   - `MS_CLIENT_ID`: [Your Microsoft Client ID]
   - `MS_CLIENT_SECRET`: [Your Microsoft Client Secret]
   - `MS_REDIRECT_URI`: `https://your-service-name.onrender.com/auth/microsoft/callback`
   - `MS_TENANT`: `common` (or your specific tenant ID)
   - `SESSION_SECRET`: [Generate a random string - Render can generate this for you]
   - `PORT`: `10000`
6. Click **Create Web Service**
7. Wait for deployment to complete (usually 2-5 minutes)

### Option B: Railway.app
1. Sign up at [railway.app](https://railway.app)
2. Click **New Project → Deploy from GitHub/GitLab**
3. Select your repository
4. Railway will auto-detect the Node.js app
5. Go to **Variables tab** and add the same environment variables as above
6. Railway will give you a domain like `https://drive-sync-app.up.railway.app`
7. Make sure to update the redirect URIs in your cloud consoles to match this domain

### Option C: Heroku
1. Sign up at [heroku.com](https://heroku.com)
2. Install Heroku CLI: `npm install -g heroku`
3. Login: `heroku login`
4. Create app: `heroku create drive-sync-app`
5. Set environment variables:
   ```bash
   heroku config:set GOOGLE_CLIENT_ID="your_google_client_id"
   heroku config:set GOOGLE_CLIENT_SECRET="your_google_client_secret"
   heroku config:set GOOGLE_REDIRECT_URI="https://drive-sync-app.herokuapp.com/auth/google/callback"
   heroku config:set MS_CLIENT_ID="your_microsoft_client_id"
   heroku config:set MS_CLIENT_SECRET="your_microsoft_client_secret"
   heroku config:set MS_REDIRECT_URI="https://drive-sync-app.herokuapp.com/auth/microsoft/callback"
   heroku config:set MS_TENANT="common"
   heroku config:set SESSION_SECRET="your_random_session_secret"
   heroku config:set PORT="3000"
   ```
6. Deploy: `git push heroku main`
7. Open: `heroku open`

## 🔄 Step 3: Update OAuth Redirect URIs

After your app is deployed and you have your live URL (e.g., `https://drive-sync-app.onrender.com`), you need to update the redirect URIs in both cloud consoles:

### Google Cloud Console
1. Go to your OAuth 2.0 Client ID credentials
2. Under **Authorized redirect URIs**, add:
   - `https://your-deployed-url.com/auth/google/callback`
   - (Keep `http://localhost:3000/auth/google/callback` for local development if desired)

### Azure Portal
1. Go to your app registration → **Authentication**
2. Under **Redirect URIs**, add:
   - `https://your-deployed-url.com/auth/microsoft/callback`
   - (Keep `http://localhost:3000/auth/microsoft/callback` for local development if desired)

## 🧪 Step 4: Test Your Deployment

1. Visit your deployed URL (e.g., `https://drive-sync-app.onrender.com`)
2. Click the Google pill to connect your Google account
3. Click the Microsoft pill to connect your Microsoft account
4. Browse your Google Drive and select files/folders to sync
5. Choose a destination folder in OneDrive (default: "DriveSync")
6. Click **Sync** and watch the progress!
7. Check your OneDrive to confirm files were copied

## 💡 Tips & Troubleshooting

### Common Issues:
1. **"Redirect URI mismatch"** - Double-check that your redirect URIs in Google/Azure exactly match what your deployed app is calling
2. **Authentication errors** - Make sure you've granted the necessary API permissions in both consoles
3. **Port issues** - The app uses `process.env.PORT || 3000`, so make sure your platform's PORT variable is set correctly
4. **Session secrets** - Use a strong random string for SESSION_SECRET (at least 32 characters)

### Environment Variables Reference:
| Variable | Description | Example |
|----------|-------------|---------|
| GOOGLE_CLIENT_ID | Google OAuth Client ID | `1234567890-abcdefg.apps.googleusercontent.com` |
| GOOGLE_CLIENT_SECRET | Google OAuth Client Secret | `GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx` |
| GOOGLE_REDIRECT_URI | Google callback URL | `https://drive-sync-app.onrender.com/auth/google/callback` |
| MS_CLIENT_ID | Microsoft Application (Client) ID | `12345678-1234-1234-1234-1234567890ab` |
| MS_CLIENT_SECRET | Microsoft Client Secret | `XXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| MS_REDIRECT_URI | Microsoft callback URL | `https://drive-sync-app.onrender.com/auth/microsoft/callback` |
| MS_TENANT | Microsoft Tenant ID | `common` (for personal accounts) |
| SESSION_SECRET | Express session secret | `your-32-character-random-string-here` |
| PORT | Server port | `10000` (Render) or `3000` (Heroku/local) |

## 📁 Files Created for Deployment

- `render.yaml` - Render.com deployment configuration
- `Procfile` - Heroku/Platform process declaration
- `.env.example` - Template for environment variables (already existed)

## 🔒 Security Notes

1. **Never commit your .env file** - It contains sensitive secrets
2. **Use environment variables** - All platforms support secure env var storage
3. **Limit API permissions** - Only grant what's necessary (Drive.readonly, Files.ReadWrite)
4. **Monitor usage** - Keep an eye on your Google Cloud and Azure usage to avoid unexpected charges

## 🔄 Updating Your Deployment

When you make changes to your code:
1. Commit and push to your git repository
2. Most platforms (Render, Railway, Heroku) will auto-deploy on push
3. Or manually trigger a redeploy from the platform's dashboard

## 🎉 You're Done!

Your Drive → OneDrive sync app is now live and accessible from anywhere! You can:
- Access it from any device with a browser
- Sync files between Google Drive and OneDrive remotely
- Share the URL with others (they'll need to connect their own accounts)
- Use it as a portfolio piece showcasing full-stack development skills

**Happy syncing!** 🚀