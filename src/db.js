import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
export const ASSET_DIR = path.join(DATA_DIR, 'library');
export const PARTIAL_DIR = path.join(DATA_DIR, 'partial');
for (const dir of [DATA_DIR, UPLOAD_DIR, OUTBOX_DIR, ASSET_DIR, PARTIAL_DIR]) fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'newsdesk.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cameraman','journalist','editor','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  source_lang TEXT NOT NULL DEFAULT 'kn',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  en_title TEXT NOT NULL DEFAULT '',
  en_summary TEXT NOT NULL DEFAULT '',
  en_body TEXT NOT NULL DEFAULT '',
  translated_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','published','rejected')),
  editor_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'dryrun' CHECK (type IN ('dryrun','wordpress','webhook')),
  config TEXT NOT NULL DEFAULT '{}',
  default_lang TEXT NOT NULL DEFAULT 'original' CHECK (default_lang IN ('original','en')),
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  lang TEXT NOT NULL,
  remote_status TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL,
  remote_id TEXT NOT NULL DEFAULT '',
  remote_url TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  published_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- In-progress resumable uploads (phone uploads arrive in chunks).
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Media library: videos and photos uploaded by cameramen, shared by all reporters.
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('video','image')),
  original_name TEXT NOT NULL,
  original_file TEXT,
  web_file TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  web_size INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','failed')),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Screenshots taken from a video.
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  t REAL NOT NULL,
  custom INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS story_assets (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, asset_id)
);
`);

// ---------- Upgrades for databases created by earlier versions ----------

function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}
addColumn('stories', 'ig_caption', "TEXT NOT NULL DEFAULT ''");
addColumn('stories', 'keywords', "TEXT NOT NULL DEFAULT ''");
addColumn('stories', 'hashtags', "TEXT NOT NULL DEFAULT ''");
addColumn('stories', 'featured_frame_id', 'INTEGER REFERENCES frames(id) ON DELETE SET NULL');
addColumn('stories', 'featured_asset_id', 'INTEGER REFERENCES assets(id) ON DELETE SET NULL');
if (addColumn('sites', 'default_media', "TEXT NOT NULL DEFAULT 'all'")) {
  db.prepare("UPDATE sites SET default_media = 'photo' WHERE key = 'belagavi-insider'").run();
}

// The users.role CHECK constraint gained 'cameraman'; SQLite needs a table rebuild for that.
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql;
if (!usersSql.includes('cameraman')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('cameraman','journalist','editor','admin')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users_new SELECT id, name, email, password_hash, role, active, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;`);
}

// First run: seed an admin account and the two news sites in dry-run mode.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@newsdesk.local';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run('Administrator', email, hashPassword(password), 'admin');
  console.log(`Created admin account ${email} (password: ${process.env.ADMIN_PASSWORD ? 'from ADMIN_PASSWORD' : password}). Change it after first login.`);
}
if (!db.prepare('SELECT 1 FROM sites LIMIT 1').get()) {
  const add = db.prepare('INSERT INTO sites (key, name, base_url, type, default_lang) VALUES (?,?,?,?,?)');
  add.run('lokadarshan', 'Lokadarshan News', 'https://lokadarshan.news', 'dryrun', 'original');
  add.run('belagavi-insider', 'Belagavi Insider', '', 'dryrun', 'en');
  db.prepare("UPDATE sites SET default_media = 'photo' WHERE key = 'belagavi-insider'").run();
}

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
