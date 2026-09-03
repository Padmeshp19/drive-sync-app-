require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const googleAuth = require('./auth/google');
const msAuth = require('./auth/microsoft');
const driveRoutes = require('./routes/drive');
const uploadRoutes = require('./routes/upload');

const app = express();

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 4 }, // 4 hours
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth status ---
app.get('/auth/status', (req, res) => {
  res.json({
    google: !!req.session.googleTokens,
    microsoft: !!req.session.msTokens,
  });
});

// --- Google OAuth ---
app.get('/auth/google', (req, res) => {
  res.redirect(googleAuth.getAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const tokens = await googleAuth.getTokensFromCode(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).send('Google authentication failed. Check server logs.');
  }
});

// --- Microsoft OAuth ---
app.get('/auth/microsoft', (req, res) => {
  res.redirect(msAuth.getAuthUrl());
});

app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const tokens = await msAuth.getTokensFromCode(req.query.code);
    req.session.msTokens = { ...tokens, obtainedAt: Date.now() };
    res.redirect('/');
  } catch (err) {
    console.error('Microsoft auth error:', err.message);
    res.status(500).send('Microsoft authentication failed. Check server logs.');
  }
});

// --- Feature routes ---
app.use('/drive', driveRoutes);
app.use('/upload', uploadRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Drive → OneDrive sync app running at http://localhost:${PORT}`);
});
