'use strict';

/**
 * Portfolio backend
 *  - Express serves the site (./public) and a small JSON API
 *  - SQLite (better-sqlite3) stores project records permanently
 *  - Multer saves uploaded Excel/CSV files to disk; the database keeps their metadata
 *  - Only the admin (password in .env) can add or delete projects; everyone can view and download
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Database = require('better-sqlite3');

/* ------------------------------------------------------------------
   Configuration
------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 10;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (ADMIN_PASSWORD.length < 8 || ADMIN_PASSWORD === 'change-this-to-a-long-password') {
  console.error('\nSet ADMIN_PASSWORD in your .env file (at least 8 characters, not the example value).\n');
  process.exit(1);
}

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set. Using a random one, so admin sessions end whenever the server restarts.');
}

const SESSION_MS = 1000 * 60 * 60 * 8; // admin stays signed in for 8 hours
const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls', '.csv']);

/* ------------------------------------------------------------------
   Database (created automatically on first run)
------------------------------------------------------------------ */
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'portfolio.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL,
    tags        TEXT    NOT NULL DEFAULT '',
    link        TEXT    NOT NULL DEFAULT '',
    file_name   TEXT,             -- original name shown to visitors
    file_stored TEXT,             -- random name on disk
    file_size   INTEGER,
    created_at  TEXT    NOT NULL
  );
`);

const listProjects = db.prepare('SELECT * FROM projects ORDER BY id DESC');
const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const deleteProjectRow = db.prepare('DELETE FROM projects WHERE id = ?');
const insertProject = db.prepare(`
  INSERT INTO projects (title, description, tags, link, file_name, file_stored, file_size, created_at)
  VALUES (@title, @description, @tags, @link, @file_name, @file_stored, @file_size, @created_at)
`);

function toPublic(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: row.tags ? row.tags.split(',') : [],
    link: row.link,
    file: row.file_stored ? { name: row.file_name, size: row.file_size } : null,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------
   Admin authentication: signed, httpOnly cookie (no user accounts needed)
------------------------------------------------------------------ */
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function makeToken() {
  const expires = String(Date.now() + SESSION_MS);
  return `${expires}.${sign(expires)}`;
}

function isValidToken(token) {
  if (typeof token !== 'string') return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(expires));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expires) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const isAdmin = (req) => isValidToken(readCookie(req, 'admin_session'));

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Sign in as admin first.' });
  next();
}

/* ------------------------------------------------------------------
   File upload handling
------------------------------------------------------------------ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`); // never trust the user's file name on disk
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      const err = new Error('Only .xlsx, .xlsm, .xls or .csv files are allowed.');
      err.code = 'UNSUPPORTED_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `The file is larger than ${MAX_UPLOAD_MB} MB.` });
    }
    if (err.code === 'UNSUPPORTED_TYPE' || err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });
}

// Confirms the file's first bytes match its extension (a renamed .exe is rejected)
function looksLikeSpreadsheet(filePath, ext) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(512);
  const read = fs.readSync(fd, buf, 0, 512, 0);
  fs.closeSync(fd);
  if (read === 0) return false;

  if (ext === '.xlsx' || ext === '.xlsm') return buf[0] === 0x50 && buf[1] === 0x4b;      // ZIP container
  if (ext === '.xls') return read >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0;              // legacy OLE file
  if (ext === '.csv') return !buf.subarray(0, read).includes(0);                           // plain text only
  return false;
}

function displayName(originalName) {
  // Browsers send UTF-8 names that multer reads as latin1; restore them so Arabic names survive.
  let name = originalName;
  const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
  if (!decoded.includes('\uFFFD')) name = decoded;
  return path.basename(name).replace(/[\u0000-\u001f\\/]/g, '').slice(0, 120) || 'spreadsheet';
}

function removeFile(fileName) {
  if (!fileName) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(fileName)), () => {});
}

/* ------------------------------------------------------------------
   Input validation
------------------------------------------------------------------ */
function parseTags(value) {
  if (typeof value !== 'string') return '';
  const seen = new Set();
  const tags = [];
  for (const raw of value.split(',')) {
    const tag = raw.trim().slice(0, 30);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 8) break;
  }
  return tags.join(',');
}

function validateProject(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const link = typeof body.link === 'string' ? body.link.trim() : '';

  if (!title) return { error: 'Enter a project title.' };
  if (title.length > 100) return { error: 'The title must be 100 characters or fewer.' };
  if (!description) return { error: 'Enter a description.' };
  if (description.length > 600) return { error: 'The description must be 600 characters or fewer.' };

  if (link) {
    let url;
    try { url = new URL(link); } catch { return { error: 'The project link is not a valid URL.' }; }
    if (!['http:', 'https:'].includes(url.protocol) || link.length > 500) {
      return { error: 'The project link must start with http:// or https://.' };
    }
  }
  return { value: { title, description, link, tags: parseTags(body.tags) } };
}

/* ------------------------------------------------------------------
   App and security middleware
------------------------------------------------------------------ */
const app = express();
if (IS_PROD) app.set('trust proxy', 1); // needed behind Render, Railway, Nginx, etc.

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: IS_PROD ? [] : null, // plain http is fine on localhost
      },
    },
  })
);

app.use(express.json({ limit: '10kb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

/* ------------------------------------------------------------------
   API routes
------------------------------------------------------------------ */
app.get('/api/session', (req, res) => {
  res.json({ admin: isAdmin(req), maxUploadMb: MAX_UPLOAD_MB });
});

app.post('/api/login', loginLimiter, (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  res.cookie('admin_session', makeToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: SESSION_MS,
    path: '/',
  });
  res.json({ admin: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_session', { path: '/' });
  res.json({ admin: false });
});

// Public: list every project
app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects.all().map(toPublic) });
});

// Public: download an attached spreadsheet
app.get('/api/projects/:id/download', (req, res, next) => {
  const row = getProject.get(Number(req.params.id));
  if (!row || !row.file_stored) return res.status(404).json({ error: 'File not found.' });

  const filePath = path.join(UPLOAD_DIR, path.basename(row.file_stored));
  res.download(filePath, row.file_name, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
      next(err);
    }
  });
});

// Admin: add a project (multipart form with an optional "file" field)
app.post('/api/projects', requireAdmin, handleUpload, (req, res) => {
  const file = req.file;
  const cleanup = () => file && removeFile(file.filename);

  const result = validateProject(req.body || {});
  if (result.error) { cleanup(); return res.status(400).json({ error: result.error }); }

  if (file && !looksLikeSpreadsheet(file.path, path.extname(file.filename).toLowerCase())) {
    cleanup();
    return res.status(400).json({ error: 'That file does not look like a valid spreadsheet.' });
  }

  const info = insertProject.run({
    ...result.value,
    file_name: file ? displayName(file.originalname) : null,
    file_stored: file ? file.filename : null,
    file_size: file ? file.size : null,
    created_at: new Date().toISOString(),
  });

  res.status(201).json({ project: toPublic(getProject.get(info.lastInsertRowid)) });
});

// Admin: delete a project and its file
app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  const row = getProject.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Project not found.' });
  deleteProjectRow.run(row.id);
  removeFile(row.file_stored);
  res.json({ deleted: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ------------------------------------------------------------------
   Static site + error handling
------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`Portfolio running at http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
});
