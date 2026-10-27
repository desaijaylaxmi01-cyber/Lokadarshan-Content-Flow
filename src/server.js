import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, UPLOAD_DIR, getSetting, setSetting } from './db.js';
import {
  COOKIE, createSession, hashPassword, verifyPassword, sessionMiddleware, requireUser, requireRole,
} from './auth.js';
import { translateStory, translationAvailable, LANGUAGES } from './translate.js';
import { publishTo, testConnection } from './publishers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 'loopback'); // behind Nginx: lets req.secure see HTTPS so cookies are marked Secure
app.use(express.json({ limit: '5mb' }));
app.use(sessionMiddleware(db));
app.use(express.static(path.join(here, '..', 'public')));

// Wrap async handlers so thrown errors become JSON responses.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const isEditor = (user) => user.role === 'editor' || user.role === 'admin';
const canPublish = (user) => isEditor(user) || getSetting('journalistsCanPublish', false);

// ---------- Auth ----------

app.post('/api/login', h(async (req, res) => {
  const { email = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.trim());
  if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  const { token, maxAge } = createSession(db, user.id);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge });
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({
    user: req.user,
    canPublish: canPublish(req.user),
    translationAvailable: translationAvailable(),
    languages: LANGUAGES,
  });
});

app.post('/api/me/password', requireUser, h(async (req, res) => {
  const { current, next } = req.body;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current || '', row.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
  if (!next || next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
}));

// ---------- Users (admin) ----------

app.get('/api/users', requireRole('admin'), (_req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all());
});

app.post('/api/users', requireRole('admin'), h(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8) throw new HttpError(400, 'Name, email and a password of 8+ characters are required.');
  if (!['journalist', 'editor', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role.');
  try {
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
      .run(name.trim(), email.trim(), hashPassword(password), role);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(400, 'A user with that email already exists.');
    throw e;
  }
}));

app.patch('/api/users/:id', requireRole('admin'), h(async (req, res) => {
  const { role, active, password } = req.body;
  const id = Number(req.params.id);
  if (id === req.user.id && (active === false || (role && role !== 'admin'))) throw new HttpError(400, 'You cannot demote or deactivate yourself.');
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (active !== undefined) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (password) {
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  }
  res.json({ ok: true });
}));

// ---------- Stories ----------

const STORY_FIELDS = ['title', 'summary', 'body', 'source_lang', 'category', 'tags', 'location', 'en_title', 'en_summary', 'en_body'];

function loadStory(req) {
  const story = db.prepare(`SELECT s.*, u.name AS author_name FROM stories s JOIN users u ON u.id = s.author_id WHERE s.id = ?`)
    .get(Number(req.params.id));
  if (!story) throw new HttpError(404, 'Story not found.');
  if (!isEditor(req.user) && story.author_id !== req.user.id) throw new HttpError(403, 'This is not your story.');
  return story;
}

function assertEditable(user, story) {
  if (!isEditor(user) && !['draft', 'rejected', 'submitted'].includes(story.status)) {
    throw new HttpError(403, 'Published stories can only be changed by an editor.');
  }
}

app.get('/api/stories', requireUser, (req, res) => {
  const mine = !isEditor(req.user) || req.query.mine === '1';
  const params = [];
  let where = '1=1';
  if (mine) { where += ' AND s.author_id = ?'; params.push(req.user.id); }
  if (req.query.status) { where += ' AND s.status = ?'; params.push(req.query.status); }
  if (req.query.q) { where += ' AND (s.title LIKE ? OR s.en_title LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  res.json(db.prepare(`
    SELECT s.id, s.title, s.en_title, s.status, s.category, s.source_lang, s.updated_at, u.name AS author_name,
      (SELECT COUNT(*) FROM media m WHERE m.story_id = s.id) AS media_count,
      (SELECT COUNT(*) FROM publications p WHERE p.story_id = s.id AND p.ok = 1) AS publish_count
    FROM stories s JOIN users u ON u.id = s.author_id
    WHERE ${where} ORDER BY s.updated_at DESC LIMIT 200`).all(...params));
});

app.post('/api/stories', requireUser, (req, res) => {
  const r = db.prepare('INSERT INTO stories (author_id, source_lang) VALUES (?, ?)').run(req.user.id, req.body.source_lang || 'kn');
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get('/api/stories/:id', requireUser, h(async (req, res) => {
  const story = loadStory(req);
  story.media = db.prepare('SELECT * FROM media WHERE story_id = ? ORDER BY id').all(story.id);
  story.publications = db.prepare(`
    SELECT p.*, si.name AS site_name, u.name AS published_by_name FROM publications p
    JOIN sites si ON si.id = p.site_id LEFT JOIN users u ON u.id = p.published_by
    WHERE p.story_id = ? ORDER BY p.id DESC`).all(story.id);
  res.json(story);
}));

app.patch('/api/stories/:id', requireUser, h(async (req, res) => {
  const story = loadStory(req);
  assertEditable(req.user, story);
  const updates = STORY_FIELDS.filter((f) => typeof req.body[f] === 'string');
  if (updates.length) {
    db.prepare(`UPDATE stories SET ${updates.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...updates.map((f) => req.body[f]), story.id);
  }
  res.json({ ok: true });
}));

app.delete('/api/stories/:id', requireUser, h(async (req, res) => {
  const story = loadStory(req);
  if (req.user.role !== 'admin' && !(story.author_id === req.user.id && story.status === 'draft')) {
    throw new HttpError(403, 'Only drafts can be deleted by their author.');
  }
  const files = db.prepare('SELECT stored_name FROM media WHERE story_id = ?').all(story.id);
  db.prepare('DELETE FROM stories WHERE id = ?').run(story.id);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  res.json({ ok: true });
}));

app.post('/api/stories/:id/submit', requireUser, h(async (req, res) => {
  const story = loadStory(req);
  if (!story.title.trim() || !story.body.trim()) throw new HttpError(400, 'Add a headline and the story script before submitting.');
  db.prepare(`UPDATE stories SET status = 'submitted', updated_at = datetime('now') WHERE id = ?`).run(story.id);
  res.json({ ok: true });
}));

app.post('/api/stories/:id/reject', requireRole('editor', 'admin'), h(async (req, res) => {
  const story = loadStory(req);
  db.prepare(`UPDATE stories SET status = 'rejected', editor_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(String(req.body.note || ''), story.id);
  res.json({ ok: true });
}));

app.post('/api/stories/:id/translate', requireUser, h(async (req, res) => {
  const story = loadStory(req);
  assertEditable(req.user, story);
  if (!translationAvailable()) throw new HttpError(503, 'Translation is not configured. Ask the admin to set ANTHROPIC_API_KEY on the server.');
  if (!story.title.trim() && !story.body.trim()) throw new HttpError(400, 'Write the headline and script before translating.');
  const result = await translateStory({ title: story.title, summary: story.summary, body: story.body, sourceLang: story.source_lang });
  db.prepare(`UPDATE stories SET en_title = ?, en_summary = ?, en_body = ?, translated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(result.title, result.summary, result.body, story.id);
  res.json(result);
}));

// ---------- Media ----------

const ALLOWED = /^(image|audio|video)\/|^application\/(pdf|msword|vnd\.openxmlformats|vnd\.ms-excel|vnd\.oasis|json|zip|x-zip)|^text\/(csv|plain)/;
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => cb(ALLOWED.test(file.mimetype) ? null : new HttpError(400, `File type not allowed: ${file.originalname}`), true),
});

const kindOf = (mime) => (mime.match(/^(image|audio|video)\//)?.[1]) || 'document';

app.post('/api/stories/:id/media', requireUser, (req, res, next) => {
  try { assertEditable(req.user, loadStory(req)); } catch (e) { return next(e); }
  next();
}, upload.array('files'), (req, res) => {
  // Browsers send UTF-8 filenames, multer decodes them as latin1.
  const insert = db.prepare('INSERT INTO media (story_id, kind, original_name, stored_name, mime, size) VALUES (?,?,?,?,?,?)');
  for (const f of req.files || []) {
    insert.run(Number(req.params.id), kindOf(f.mimetype), Buffer.from(f.originalname, 'latin1').toString('utf8'), f.filename, f.mimetype, f.size);
  }
  db.prepare(`UPDATE stories SET updated_at = datetime('now') WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true, count: (req.files || []).length });
});

function loadMedia(req) {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.mediaId));
  if (!m) throw new HttpError(404, 'File not found.');
  const story = loadStory({ ...req, params: { id: m.story_id } });
  return { m, story };
}

app.get('/api/media/:mediaId/file', requireUser, h(async (req, res) => {
  const { m } = loadMedia(req);
  res.type(m.mime);
  res.sendFile(path.join(UPLOAD_DIR, m.stored_name), { headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.original_name)}` } });
}));

app.patch('/api/media/:mediaId', requireUser, h(async (req, res) => {
  const { m, story } = loadMedia(req);
  assertEditable(req.user, story);
  db.prepare('UPDATE media SET caption = ? WHERE id = ?').run(String(req.body.caption || ''), m.id);
  res.json({ ok: true });
}));

app.delete('/api/media/:mediaId', requireUser, h(async (req, res) => {
  const { m, story } = loadMedia(req);
  assertEditable(req.user, story);
  db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  fs.rm(path.join(UPLOAD_DIR, m.stored_name), { force: true }, () => {});
  res.json({ ok: true });
}));

// ---------- Sites & publishing ----------

const SECRET_KEYS = ['appPassword', 'token'];
const parseSite = (row) => ({ ...row, config: JSON.parse(row.config), enabled: Boolean(row.enabled) });

function publicSite(site, admin) {
  if (!admin) return { id: site.id, key: site.key, name: site.name, base_url: site.base_url, type: site.type, default_lang: site.default_lang, enabled: site.enabled };
  const config = { ...site.config };
  for (const k of SECRET_KEYS) if (config[k]) config[k] = '••••••••';
  return { ...site, config };
}

app.get('/api/sites', requireUser, (req, res) => {
  const admin = req.user.role === 'admin';
  res.json(db.prepare('SELECT * FROM sites ORDER BY id').all().map(parseSite).filter((s) => admin || s.enabled).map((s) => publicSite(s, admin)));
});

app.post('/api/sites', requireRole('admin'), h(async (req, res) => {
  const { name } = req.body;
  if (!name) throw new HttpError(400, 'Site name is required.');
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  const r = db.prepare('INSERT INTO sites (key, name) VALUES (?, ?)').run(key, name);
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.patch('/api/sites/:id', requireRole('admin'), h(async (req, res) => {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Site not found.');
  const site = parseSite(row);
  const { name, base_url, type, default_lang, enabled, config = {} } = req.body;
  const merged = { ...site.config };
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEYS.includes(k) && v === '••••••••') continue; // unchanged secret
    merged[k] = v;
  }
  db.prepare('UPDATE sites SET name = ?, base_url = ?, type = ?, default_lang = ?, enabled = ?, config = ? WHERE id = ?').run(
    name ?? site.name, base_url ?? site.base_url, type ?? site.type, default_lang ?? site.default_lang,
    (enabled ?? site.enabled) ? 1 : 0, JSON.stringify(merged), site.id);
  res.json({ ok: true });
}));

app.post('/api/sites/:id/test', requireRole('admin'), h(async (req, res) => {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Site not found.');
  res.json({ message: await testConnection(parseSite(row)) });
}));

app.get('/api/settings', requireRole('admin'), (_req, res) => {
  res.json({ journalistsCanPublish: getSetting('journalistsCanPublish', false) });
});

app.patch('/api/settings', requireRole('admin'), (req, res) => {
  if ('journalistsCanPublish' in req.body) setSetting('journalistsCanPublish', Boolean(req.body.journalistsCanPublish));
  res.json({ ok: true });
});

app.post('/api/stories/:id/publish', requireUser, h(async (req, res) => {
  if (!canPublish(req.user)) throw new HttpError(403, 'Only editors can publish. Submit the story for review instead.');
  const story = loadStory(req);
  const targets = Array.isArray(req.body.targets) ? req.body.targets : [];
  if (!targets.length) throw new HttpError(400, 'Choose at least one website.');
  const media = db.prepare('SELECT * FROM media WHERE story_id = ? ORDER BY id').all(story.id);
  const record = db.prepare(`INSERT INTO publications (story_id, site_id, lang, remote_status, ok, remote_id, remote_url, message, published_by)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const results = [];
  for (const t of targets) {
    const row = db.prepare('SELECT * FROM sites WHERE id = ? AND enabled = 1').get(Number(t.siteId));
    if (!row) { results.push({ siteId: t.siteId, ok: false, message: 'Site not found or disabled.' }); continue; }
    const site = parseSite(row);
    const lang = t.lang === 'en' ? 'en' : 'original';
    const status = t.status === 'draft' ? 'draft' : 'publish';
    try {
      const out = await publishTo(site, story, lang, media, { status });
      record.run(story.id, site.id, lang, status, 1, out.remoteId, out.url, out.message, req.user.id);
      results.push({ site: site.name, lang, ok: true, ...out });
    } catch (e) {
      record.run(story.id, site.id, lang, status, 0, '', '', e.message, req.user.id);
      results.push({ site: site.name, lang, ok: false, message: e.message });
    }
  }
  if (results.some((r) => r.ok)) {
    db.prepare(`UPDATE stories SET status = 'published', updated_at = datetime('now') WHERE id = ?`).run(story.id);
  }
  res.json({ results });
}));

// ---------- Errors & SPA fallback ----------

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${process.env.MAX_UPLOAD_MB || 2048} MB.` : err.message;
    return res.status(400).json({ error: msg });
  }
  const status = err.status || 500;
  if (!(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err instanceof HttpError || status < 500 ? err.message : `Server error: ${err.message}` });
});

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`Newsdesk running at http://localhost:${port}`));
}
export default app;
