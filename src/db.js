import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
for (const dir of [DATA_DIR, UPLOAD_DIR, OUTBOX_DIR]) fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'newsdesk.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('journalist','editor','admin')),
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
`);

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
}

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
