# Youssef Ahmed: Accounting Portfolio (full-stack)

A portfolio site with a real backend. Projects and their Excel files are stored on the server, so every visitor sees them and they never disappear when a browser is cleared.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | HTML, CSS, vanilla JavaScript (`public/`) | No build step, fast, easy to edit |
| Backend | Node.js + Express (`server.js`) | Small, widely hosted |
| Database | SQLite via `better-sqlite3` | A real database in one file, no separate server to run |
| File uploads | Multer (files saved to `data/uploads/`) | Standard, with size and type limits |
| Security | Helmet, rate limiting, signed admin cookie | Only you can add or delete; visitors can only view and download |

## Project layout

```
portfolio/
  server.js          Express app, API, database, uploads, admin login
  package.json
  .env.example       Copy to .env and edit
  public/
    index.html       The page
    styles.css       Design
    app.js           Talks to the API
  data/              Created on first run: portfolio.db + uploads/
```

## Set up and run (about 5 minutes)

1. **Install Node.js 18 or newer** from https://nodejs.org (check with `node --version`).
2. **Open a terminal in the `portfolio` folder** and install the dependencies:
   ```
   npm install
   ```
3. **Create your settings file.** Copy `.env.example` to `.env`:
   - macOS / Linux: `cp .env.example .env`
   - Windows (PowerShell): `Copy-Item .env.example .env`
4. **Edit `.env`:**
   - `ADMIN_PASSWORD`: choose a long password. This is what you type to add projects.
   - `SESSION_SECRET`: generate one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
     and paste the result.
5. **Start the server:**
   ```
   npm start
   ```
6. **Open http://localhost:3000.** Do not open `index.html` by double-clicking; the page needs the server.

The database file and the uploads folder are created automatically in `data/`.

## Add a project

1. Scroll to the footer and select **Admin sign in**. Enter your password.
2. In the Projects section, select **Add project**.
3. Fill in the title, description, tags, an optional link, and choose an Excel file (`.xlsx`, `.xlsm`, `.xls` or `.csv`, up to `MAX_UPLOAD_MB`).
4. Select **Save project**. It is saved to the database and appears for every visitor, with a **Download** button for the spreadsheet.
5. Use **Delete** on a card to remove it and its file. Select **Sign out** in the footer when finished.

## How it works

- **Database:** one table, `projects` (title, description, tags, link, file name, stored file name, file size, created date).
- **Uploads:** each file is saved with a random name in `data/uploads/`, so names can't clash or be guessed. The original name is kept in the database and used for the download. Files are only served through `/api/projects/:id/download`, never directly from the folder.
- **Checks on upload:** allowed extensions only, a size limit, and a check that the file's first bytes match a real spreadsheet.
- **Admin login:** the password in `.env` is compared in constant time. A correct password sets a signed, `httpOnly`, `SameSite=Strict` cookie that lasts 8 hours. Login attempts are limited to 10 per 15 minutes per IP.

### API

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/projects` | Public | List projects |
| GET | `/api/projects/:id/download` | Public | Download the attached file |
| GET | `/api/session` | Public | Is the visitor signed in as admin? |
| POST | `/api/login` | Public, rate-limited | Sign in with the admin password |
| POST | `/api/logout` | Public | Sign out |
| POST | `/api/projects` | Admin | Add a project (multipart form) |
| DELETE | `/api/projects/:id` | Admin | Delete a project and its file |

## Put it online

The site needs a host that runs Node.js **and keeps a persistent disk**, because the database and uploads are files.

1. Push the folder to a private GitHub repository (`.gitignore` already excludes `.env` and `data/`).
2. Create a Node web service on a host such as Render or Railway.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add a **persistent disk or volume** (for example mounted at `/var/data`) and set `DATA_DIR` to that path. Without it, uploads and projects are erased on every deploy.
4. Set these environment variables on the host: `ADMIN_PASSWORD`, `SESSION_SECRET`, `DATA_DIR`, `NODE_ENV=production`.
5. Open the URL the host gives you and sign in.

Notes:
- `NODE_ENV=production` makes the admin cookie HTTPS-only, so it needs the HTTPS address your host provides. Use it only online, not on localhost.
- Free plans often have no persistent disk. If yours doesn't, use a paid plan with a disk, or switch storage as described below.
- **Back up** the whole `DATA_DIR` folder (`portfolio.db` and `uploads/`) regularly.

## Using Supabase or Firebase instead

If your host has no persistent disk, replace the storage layer in `server.js`: keep the same API routes, but save rows to a Supabase Postgres table and files to a Supabase Storage bucket (the download route then redirects to a signed URL). The frontend does not need to change.

## Troubleshooting

- **"Set ADMIN_PASSWORD in your .env file":** you skipped step 3 or 4, or left the example password.
- **Page says "Projects could not be loaded":** the server isn't running, or you opened the HTML file directly.
- **`npm install` fails on `better-sqlite3`:** use a current Node LTS version. On Windows, the installer's "build tools" option is sometimes needed.
- **Upload rejected:** check the extension, the size limit, and that the file opens in Excel.
- **Forgot the password:** change `ADMIN_PASSWORD` in `.env` and restart.
