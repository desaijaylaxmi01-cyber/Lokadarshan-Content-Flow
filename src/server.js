import './env.js';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, UPLOAD_DIR, ASSET_DIR, PARTIAL_DIR, getSetting, setSetting } from './db.js';
import {
  COOKIE, createSession, hashPassword, verifyPassword, sessionMiddleware, requireUser, requireRole,
} from './auth.js';
import { translateStory, translationAvailable, LANGUAGES } from './translate.js';
import { publishTo, testConnection } from './publishers.js';
import { enqueue, grabFrame, assetPath, startMediaWorker, diskUsage, ffmpegAvailable, convertToM4a } from './media.js';

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
const requireWriter = requireRole('journalist', 'editor', 'admin');
const requireVideoDesk = requireRole('video_editor', 'editor', 'admin');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);
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
    maxUploadMb: MAX_UPLOAD_MB,
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
  if (!['cameraman', 'journalist', 'video_editor', 'editor', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role.');
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

function storyFilesByPurpose(storyId) {
  const all = db.prepare('SELECT * FROM media WHERE story_id = ? ORDER BY id').all(storyId);
  return {
    media: all.filter((m) => m.purpose === ''),
    voiceovers: all.filter((m) => m.purpose === 'voiceover'),
    finals: all.filter((m) => m.purpose.startsWith('final_')),
  };
}

const videoTasks = (storyId) => db.prepare(`SELECT v.*, u.name AS editor_name FROM video_tasks v
  LEFT JOIN users u ON u.id = v.editor_id WHERE v.story_id = ? ORDER BY v.platform`).all(storyId);

const youtubeUrl = (storyId) => db.prepare(`SELECT final_url FROM video_tasks
  WHERE story_id = ? AND platform = 'youtube' AND status = 'done' AND final_url != ''`).get(storyId)?.final_url || '';

const STORY_FIELDS = ['title', 'summary', 'body', 'source_lang', 'category', 'tags', 'location', 'en_title', 'en_summary', 'en_body',
  'ig_caption', 'keywords', 'hashtags', 'yt_title', 'yt_description'];

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

app.get('/api/stories', requireWriter, (req, res) => {
  const mine = !isEditor(req.user) || req.query.mine === '1';
  const params = [];
  let where = '1=1';
  if (mine) { where += ' AND s.author_id = ?'; params.push(req.user.id); }
  if (req.query.status) { where += ' AND s.status = ?'; params.push(req.query.status); }
  if (req.query.q) { where += ' AND (s.title LIKE ? OR s.en_title LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  res.json(db.prepare(`
    SELECT s.id, s.title, s.en_title, s.status, s.category, s.source_lang, s.updated_at, u.name AS author_name,
      s.featured_frame_id, s.featured_asset_id,
      (SELECT COUNT(*) FROM story_assets sa WHERE sa.story_id = s.id) AS asset_count,
      (SELECT COUNT(*) FROM media m WHERE m.story_id = s.id AND m.purpose = '') AS media_count,
      (SELECT COUNT(*) FROM media m WHERE m.story_id = s.id AND m.purpose = 'voiceover') AS voiceover_count,
      (SELECT COUNT(*) FROM publications p WHERE p.story_id = s.id AND p.ok = 1) AS publish_count,
      (SELECT GROUP_CONCAT(DISTINCT p.site_id) FROM publications p WHERE p.story_id = s.id AND p.ok = 1) AS published_site_ids,
      (SELECT status FROM video_tasks v WHERE v.story_id = s.id AND v.platform = 'instagram') AS ig_task,
      (SELECT status FROM video_tasks v WHERE v.story_id = s.id AND v.platform = 'youtube') AS yt_task
    FROM stories s JOIN users u ON u.id = s.author_id
    WHERE ${where} ORDER BY s.updated_at DESC LIMIT 200`).all(...params));
});

app.post('/api/stories', requireWriter, (req, res) => {
  const r = db.prepare('INSERT INTO stories (author_id, source_lang) VALUES (?, ?)').run(req.user.id, req.body.source_lang || 'kn');
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get('/api/stories/:id', requireWriter, h(async (req, res) => {
  const story = loadStory(req);
  Object.assign(story, storyFilesByPurpose(story.id));
  story.video_tasks = videoTasks(story.id);
  story.assets = db.prepare(`SELECT a.*, u.name AS uploader_name FROM story_assets sa JOIN assets a ON a.id = sa.asset_id
    JOIN users u ON u.id = a.uploader_id WHERE sa.story_id = ? ORDER BY a.id`).all(story.id).map(withFrames);
  story.publications = db.prepare(`
    SELECT p.*, si.name AS site_name, u.name AS published_by_name FROM publications p
    JOIN sites si ON si.id = p.site_id LEFT JOIN users u ON u.id = p.published_by
    WHERE p.story_id = ? ORDER BY p.id DESC`).all(story.id);
  res.json(story);
}));

app.patch('/api/stories/:id', requireWriter, h(async (req, res) => {
  const story = loadStory(req);
  assertEditable(req.user, story);
  const updates = STORY_FIELDS.filter((f) => typeof req.body[f] === 'string');
  // Featured picture is either a video screenshot or a library photo, never both.
  if ('featured_frame_id' in req.body) {
    db.prepare('UPDATE stories SET featured_frame_id = ?, featured_asset_id = NULL WHERE id = ?').run(req.body.featured_frame_id ?? null, story.id);
  } else if ('featured_asset_id' in req.body) {
    db.prepare('UPDATE stories SET featured_asset_id = ?, featured_frame_id = NULL WHERE id = ?').run(req.body.featured_asset_id ?? null, story.id);
  }
  if (updates.length) {
    db.prepare(`UPDATE stories SET ${updates.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...updates.map((f) => req.body[f]), story.id);
  }
  res.json({ ok: true });
}));

app.delete('/api/stories/:id', requireWriter, h(async (req, res) => {
  const story = loadStory(req);
  if (req.user.role !== 'admin' && !(story.author_id === req.user.id && story.status === 'draft')) {
    throw new HttpError(403, 'Only drafts can be deleted by their author.');
  }
  const files = db.prepare('SELECT stored_name FROM media WHERE story_id = ?').all(story.id);
  db.prepare('DELETE FROM stories WHERE id = ?').run(story.id);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  res.json({ ok: true });
}));

app.post('/api/stories/:id/submit', requireWriter, h(async (req, res) => {
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

app.post('/api/stories/:id/translate', requireWriter, h(async (req, res) => {
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

app.post('/api/stories/:id/media', requireWriter, (req, res, next) => {
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

app.get('/api/media/:mediaId/file', requireWriter, h(async (req, res) => {
  const { m } = loadMedia(req);
  res.type(m.mime);
  res.sendFile(path.join(UPLOAD_DIR, m.stored_name), { headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.original_name)}` } });
}));

app.patch('/api/media/:mediaId', requireWriter, h(async (req, res) => {
  const { m, story } = loadMedia(req);
  assertEditable(req.user, story);
  db.prepare('UPDATE media SET caption = ? WHERE id = ?').run(String(req.body.caption || ''), m.id);
  res.json({ ok: true });
}));

app.delete('/api/media/:mediaId', requireWriter, h(async (req, res) => {
  const { m, story } = loadMedia(req);
  assertEditable(req.user, story);
  db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  fs.rm(path.join(UPLOAD_DIR, m.stored_name), { force: true }, () => {});
  res.json({ ok: true });
}));

// ---------- Media library (cameraman uploads) ----------

const LIBRARY_TYPES = /^(image|video)\//;

function withFrames(asset) {
  asset.frames = db.prepare('SELECT id, t, custom FROM frames WHERE asset_id = ? ORDER BY t').all(asset.id);
  return asset;
}

function loadAsset(id) {
  const a = db.prepare('SELECT a.*, u.name AS uploader_name FROM assets a JOIN users u ON u.id = a.uploader_id WHERE a.id = ?').get(Number(id));
  if (!a) throw new HttpError(404, 'Video or photo not found.');
  return a;
}

function loadUpload(req) {
  const u = db.prepare('SELECT * FROM uploads WHERE id = ?').get(String(req.params.id));
  if (!u || u.user_id !== req.user.id) throw new HttpError(404, 'Upload not found. Please choose the file again.');
  return u;
}

// Resumable upload, step 1: announce the file.
app.post('/api/uploads', requireUser, h(async (req, res) => {
  const { name = '', size = 0, mime = '' } = req.body;
  if (!LIBRARY_TYPES.test(mime)) throw new HttpError(400, `Only videos and photos can go to the media library (${name}).`);
  if (!(size > 0) || size > MAX_UPLOAD_MB * 1024 * 1024) throw new HttpError(400, `File must be smaller than ${MAX_UPLOAD_MB} MB.`);
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO uploads (id, user_id, name, mime, size) VALUES (?,?,?,?,?)').run(id, req.user.id, String(name).slice(0, 200), mime, size);
  fs.writeFileSync(path.join(PARTIAL_DIR, id), '');
  res.json({ id, received: 0 });
}));

// Step 1b: after a network drop, ask how much arrived.
app.get('/api/uploads/:id', requireUser, h(async (req, res) => {
  const u = loadUpload(req);
  res.json({ id: u.id, received: u.received, size: u.size });
}));

// Step 2: send the next chunk. Upload-Offset must equal the bytes already received.
app.put('/api/uploads/:id', requireUser, express.raw({ type: () => true, limit: '20mb' }), h(async (req, res) => {
  const u = loadUpload(req);
  const offset = Number(req.get('Upload-Offset'));
  if (offset !== u.received) return res.status(409).json({ error: 'Offset mismatch', received: u.received });
  const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (u.received + chunk.length > u.size) throw new HttpError(400, 'More data than the announced file size.');
  await fs.promises.appendFile(path.join(PARTIAL_DIR, u.id), chunk);
  const received = u.received + chunk.length;
  db.prepare('UPDATE uploads SET received = ? WHERE id = ?').run(received, u.id);
  res.json({ received });
}));

// Step 3: all bytes arrived; add to the library and start processing.
app.post('/api/uploads/:id/complete', requireUser, h(async (req, res) => {
  const u = loadUpload(req);
  if (u.received !== u.size) throw new HttpError(400, `Upload incomplete (${u.received} of ${u.size} bytes).`);
  const ext = (path.extname(u.name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0];
  const file = `${u.id}${ext}`;
  fs.renameSync(path.join(PARTIAL_DIR, u.id), assetPath(file));
  db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  const r = db.prepare('INSERT INTO assets (uploader_id, kind, original_name, original_file, mime, size, note, location) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, u.mime.startsWith('video/') ? 'video' : 'image', u.name, file, u.mime, u.size,
      String(req.body.note || '').slice(0, 2000), String(req.body.location || '').slice(0, 200));
  const id = Number(r.lastInsertRowid);
  enqueue(id);
  res.json({ id });
}));

app.get('/api/assets', requireUser, (req, res) => {
  const where = ['1=1'];
  const params = [];
  if (req.query.mine === '1' || req.user.role === 'cameraman' && req.query.all !== '1') { where.push('a.uploader_id = ?'); params.push(req.user.id); }
  if (req.query.kind) { where.push('a.kind = ?'); params.push(String(req.query.kind)); }
  if (req.query.days) { where.push(`a.created_at >= datetime('now', ?)`); params.push(`-${Number(req.query.days)} days`); }
  if (req.query.q) {
    where.push('(a.note LIKE ? OR a.location LIKE ? OR a.original_name LIKE ? OR u.name LIKE ?)');
    params.push(...Array(4).fill(`%${req.query.q}%`));
  }
  res.json(db.prepare(`
    SELECT a.id, a.kind, a.original_name, a.note, a.location, a.status, a.error, a.duration, a.size, a.created_at,
      a.original_file IS NOT NULL AS has_original, u.name AS uploader_name,
      (SELECT f.id FROM frames f WHERE f.asset_id = a.id ORDER BY f.custom, f.t LIMIT 1 OFFSET 0) AS thumb_frame_id,
      (SELECT COUNT(*) FROM story_assets sa WHERE sa.asset_id = a.id) AS story_count
    FROM assets a JOIN users u ON u.id = a.uploader_id
    WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 200`).all(...params));
});

app.get('/api/assets/:id', requireUser, h(async (req, res) => {
  res.json(withFrames(loadAsset(req.params.id)));
}));

app.patch('/api/assets/:id', requireUser, h(async (req, res) => {
  const a = loadAsset(req.params.id);
  if (a.uploader_id !== req.user.id && !isEditor(req.user)) throw new HttpError(403, 'Only the uploader or an editor can change this.');
  db.prepare('UPDATE assets SET note = COALESCE(?, note), location = COALESCE(?, location) WHERE id = ?')
    .run(req.body.note ?? null, req.body.location ?? null, a.id);
  res.json({ ok: true });
}));

app.delete('/api/assets/:id', requireUser, h(async (req, res) => {
  const a = loadAsset(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM story_assets WHERE asset_id = ?').get(a.id).n;
  if (!isEditor(req.user) && (a.uploader_id !== req.user.id || used)) {
    throw new HttpError(403, used ? 'This is already used in a story. Ask an editor to delete it.' : 'Only the uploader or an editor can delete this.');
  }
  const frames = db.prepare('SELECT file FROM frames WHERE asset_id = ?').all(a.id);
  db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
  for (const f of [a.original_file, a.web_file, ...frames.map((x) => x.file)]) if (f) fs.rmSync(assetPath(f), { force: true });
  res.json({ ok: true });
}));

app.get('/api/assets/:id/web', requireUser, h(async (req, res) => {
  const a = loadAsset(req.params.id);
  if (!a.web_file) throw new HttpError(404, 'Still processing.');
  res.sendFile(assetPath(a.web_file));
}));

app.get('/api/assets/:id/original', requireUser, h(async (req, res) => {
  const a = loadAsset(req.params.id);
  const file = a.original_file || a.web_file;
  if (!file) throw new HttpError(404, 'File not available.');
  const name = a.original_file ? a.original_name : a.original_name.replace(/\.[^.]+$/, '') + path.extname(a.web_file);
  res.download(assetPath(file), name);
}));

app.get('/api/frames/:id/file', requireUser, h(async (req, res) => {
  const f = db.prepare('SELECT file FROM frames WHERE id = ?').get(Number(req.params.id));
  if (!f) throw new HttpError(404, 'Screenshot not found.');
  res.set('Cache-Control', 'private, max-age=86400').sendFile(assetPath(f.file));
}));

// "Use this frame": screenshot at the exact moment the reporter paused the video.
app.post('/api/assets/:id/frames', requireWriter, h(async (req, res) => {
  const a = loadAsset(req.params.id);
  if (a.kind !== 'video' || a.status !== 'ready') throw new HttpError(400, 'Video is not ready yet.');
  if (!ffmpegAvailable) throw new HttpError(503, 'Screenshots need ffmpeg installed on the server.');
  const t = Math.min(Math.max(Number(req.body.t) || 0, 0), Math.max(a.duration - 0.05, 0));
  const id = await grabFrame(a.id, a.web_file, t, true);
  res.json({ id, t });
}));

app.post('/api/stories/:id/assets', requireWriter, h(async (req, res) => {
  const story = loadStory(req);
  assertEditable(req.user, story);
  const a = loadAsset(req.body.assetId);
  db.prepare('INSERT OR IGNORE INTO story_assets (story_id, asset_id) VALUES (?, ?)').run(story.id, a.id);
  // First video tagged: use its middle screenshot as the photo until the reporter picks one.
  if (!story.featured_frame_id && !story.featured_asset_id) {
    const frames = db.prepare('SELECT id FROM frames WHERE asset_id = ? AND custom = 0 ORDER BY t').all(a.id);
    if (frames.length) db.prepare('UPDATE stories SET featured_frame_id = ? WHERE id = ?').run(frames[Math.floor(frames.length / 2)].id, story.id);
    else if (a.kind === 'image') db.prepare('UPDATE stories SET featured_asset_id = ? WHERE id = ?').run(a.id, story.id);
  }
  res.json({ ok: true });
}));

app.delete('/api/stories/:id/assets/:assetId', requireWriter, h(async (req, res) => {
  const story = loadStory(req);
  assertEditable(req.user, story);
  const assetId = Number(req.params.assetId);
  db.prepare('DELETE FROM story_assets WHERE story_id = ? AND asset_id = ?').run(story.id, assetId);
  db.prepare(`UPDATE stories SET featured_frame_id = NULL WHERE id = ? AND featured_frame_id IN (SELECT id FROM frames WHERE asset_id = ?)`).run(story.id, assetId);
  db.prepare('UPDATE stories SET featured_asset_id = NULL WHERE id = ? AND featured_asset_id = ?').run(story.id, assetId);
  res.json({ ok: true });
}));

/** Files sent to a website: featured photo first (WordPress makes it the main image), then videos and other files. */
function publishMedia(story, mode) {
  const files = [];
  const base = `story-${story.id}`;
  let featuredAssetId = null;
  const frame = story.featured_frame_id && db.prepare('SELECT file FROM frames WHERE id = ?').get(story.featured_frame_id);
  if (frame) {
    const p = assetPath(frame.file);
    files.push({ kind: 'image', original_name: `${base}-photo.jpg`, mime: 'image/jpeg', size: fs.statSync(p).size, caption: '', path: p });
  } else if (story.featured_asset_id) {
    const a = db.prepare('SELECT * FROM assets WHERE id = ? AND web_file IS NOT NULL').get(story.featured_asset_id);
    if (a) {
      featuredAssetId = a.id;
      files.push({ kind: 'image', original_name: `${base}-photo${path.extname(a.web_file)}`, mime: a.web_file === a.original_file ? a.mime : 'image/jpeg',
        size: a.web_size, caption: '', path: assetPath(a.web_file) });
    }
  }
  const storyFiles = db.prepare("SELECT * FROM media WHERE story_id = ? AND purpose = '' ORDER BY id").all(story.id)
    .map((m) => ({ ...m, path: path.join(UPLOAD_DIR, m.stored_name) }));
  if (mode === 'photo') {
    if (!files.length) files.push(...storyFiles.filter((m) => m.kind === 'image').slice(0, 1));
    return files;
  }
  const linked = db.prepare(`SELECT a.* FROM story_assets sa JOIN assets a ON a.id = sa.asset_id
    WHERE sa.story_id = ? AND a.status = 'ready' ORDER BY a.id`).all(story.id);
  const embedYoutube = Boolean(youtubeUrl(story.id));
  for (const a of linked) {
    if (a.id === featuredAssetId) continue;
    if (a.kind === 'video' && embedYoutube) continue; // the website embeds the YouTube video instead
    const processed = a.web_file !== a.original_file;
    files.push({
      kind: a.kind, size: a.web_size, caption: '', path: assetPath(a.web_file),
      mime: processed ? (a.kind === 'video' ? 'video/mp4' : 'image/jpeg') : a.mime,
      original_name: processed ? a.original_name.replace(/\.[^.]+$/, '') + path.extname(a.web_file) : a.original_name,
    });
  }
  return files.concat(storyFiles);
}

// ---------- Voiceover (reporter) ----------

const voiceUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + (path.extname(file.originalname).toLowerCase() || '.webm')),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(/^(audio|video)\//.test(file.mimetype) ? null : new HttpError(400, 'Please choose an audio file.'), true),
});

app.post('/api/stories/:id/voiceover', requireWriter, (req, _res, next) => {
  try { assertEditable(req.user, loadStory(req)); next(); } catch (e) { next(e); }
}, voiceUpload.single('file'), h(async (req, res) => {
  const f = req.file;
  if (!f) throw new HttpError(400, 'No audio received.');
  const storyId = Number(req.params.id);
  const n = db.prepare("SELECT COUNT(*) AS n FROM media WHERE story_id = ? AND purpose = 'voiceover'").get(storyId).n + 1;
  let stored = f.filename, mime = f.mimetype, size = f.size;
  const m4a = `${path.parse(f.filename).name}.m4a`;
  try {
    if (path.extname(f.filename) !== '.m4a' && await convertToM4a(f.path, path.join(UPLOAD_DIR, m4a))) {
      fs.rmSync(f.path, { force: true });
      stored = m4a; mime = 'audio/mp4'; size = fs.statSync(path.join(UPLOAD_DIR, m4a)).size;
    }
  } catch (e) {
    console.error('Voiceover conversion failed, keeping original:', e.message);
  }
  db.prepare(`INSERT INTO media (story_id, kind, original_name, stored_name, mime, size, purpose, caption) VALUES (?,?,?,?,?,?,?,?)`)
    .run(storyId, 'audio', `voiceover-${n}${path.extname(stored)}`, stored, mime, size, 'voiceover', String(req.body.label || ''));
  db.prepare(`UPDATE stories SET updated_at = datetime('now') WHERE id = ?`).run(storyId);
  res.json({ ok: true });
}));

// ---------- Video desk (Instagram / YouTube editing) ----------

app.post('/api/stories/:id/video-tasks', requireWriter, h(async (req, res) => {
  const story = loadStory(req);
  const platforms = (req.body.platforms || []).filter((p) => p === 'instagram' || p === 'youtube');
  if (!platforms.length) throw new HttpError(400, 'Choose Instagram and/or YouTube.');
  const add = db.prepare('INSERT OR IGNORE INTO video_tasks (story_id, platform, note) VALUES (?, ?, ?)');
  for (const p of platforms) add.run(story.id, p, String(req.body.note || ''));
  res.json({ ok: true });
}));

app.delete('/api/video-tasks/:id', requireWriter, h(async (req, res) => {
  const t = db.prepare('SELECT * FROM video_tasks WHERE id = ?').get(Number(req.params.id));
  if (!t) throw new HttpError(404, 'Task not found.');
  loadStory({ ...req, params: { id: t.story_id } });
  if (t.status !== 'todo' && !isEditor(req.user)) throw new HttpError(403, 'The video editor has already started this.');
  db.prepare('DELETE FROM video_tasks WHERE id = ?').run(t.id);
  res.json({ ok: true });
}));

app.patch('/api/video-tasks/:id', requireVideoDesk, h(async (req, res) => {
  const t = db.prepare('SELECT * FROM video_tasks WHERE id = ?').get(Number(req.params.id));
  if (!t) throw new HttpError(404, 'Task not found.');
  const status = ['todo', 'editing', 'done'].includes(req.body.status) ? req.body.status : t.status;
  const finalUrl = typeof req.body.final_url === 'string' ? req.body.final_url.trim() : t.final_url;
  if (finalUrl && !/^https?:\/\//i.test(finalUrl)) throw new HttpError(400, 'The link must start with https://');
  const editorId = status === 'todo' ? null : (t.editor_id || req.user.id);
  db.prepare(`UPDATE video_tasks SET status = ?, final_url = ?, editor_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, finalUrl, editorId, t.id);
  res.json({ ok: true });
}));

app.get('/api/video-desk', requireVideoDesk, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.en_title, s.location, s.featured_frame_id, s.featured_asset_id, u.name AS author_name,
      MIN(v.created_at) AS sent_at, MAX(v.updated_at) AS updated_at,
      (SELECT COUNT(*) FROM media m WHERE m.story_id = s.id AND m.purpose = 'voiceover') AS voiceover_count,
      (SELECT COUNT(*) FROM story_assets sa JOIN assets a ON a.id = sa.asset_id WHERE sa.story_id = s.id AND a.kind = 'video') AS video_count
    FROM video_tasks v JOIN stories s ON s.id = v.story_id JOIN users u ON u.id = s.author_id
    GROUP BY s.id ORDER BY MIN(v.status = 'done'), sent_at DESC LIMIT 200`).all();
  for (const r of rows) r.tasks = videoTasks(r.id);
  res.json(rows);
});

function loadDeskStory(req) {
  const story = db.prepare(`SELECT s.*, u.name AS author_name FROM stories s JOIN users u ON u.id = s.author_id WHERE s.id = ?`)
    .get(Number(req.params.id));
  if (!story) throw new HttpError(404, 'Story not found.');
  if (!isEditor(req.user) && !db.prepare('SELECT 1 FROM video_tasks WHERE story_id = ?').get(story.id)) {
    throw new HttpError(403, 'This story has not been sent to the video desk.');
  }
  return story;
}

app.get('/api/video-desk/:id', requireVideoDesk, h(async (req, res) => {
  const story = loadDeskStory(req);
  Object.assign(story, storyFilesByPurpose(story.id));
  story.video_tasks = videoTasks(story.id);
  story.assets = db.prepare(`SELECT a.*, u.name AS uploader_name FROM story_assets sa JOIN assets a ON a.id = sa.asset_id
    JOIN users u ON u.id = a.uploader_id WHERE sa.story_id = ? ORDER BY a.id`).all(story.id).map(withFrames);
  res.json(story);
}));

app.get('/api/video-desk/:id/media/:mediaId', requireVideoDesk, h(async (req, res) => {
  const story = loadDeskStory(req);
  const m = db.prepare('SELECT * FROM media WHERE id = ? AND story_id = ?').get(Number(req.params.mediaId), story.id);
  if (!m) throw new HttpError(404, 'File not found.');
  res.type(m.mime);
  res.sendFile(path.join(UPLOAD_DIR, m.stored_name), { headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.original_name)}` } });
}));

const BOM = '﻿';
const block = (...lines) => BOM + lines.filter((l) => l !== null).join('\r\n') + '\r\n';

/** Everything the video editor needs for one story, as a single ZIP. Videos are stored, not re-compressed. */
app.get('/api/video-desk/:id/package.zip', requireVideoDesk, h(async (req, res) => {
  const story = loadDeskStory(req);
  const dir = `story-${story.id}`;
  const lang = LANGUAGES[story.source_lang] || 'Original';
  const assets = db.prepare(`SELECT a.*, u.name AS uploader_name FROM story_assets sa JOIN assets a ON a.id = sa.asset_id
    JOIN users u ON u.id = a.uploader_id WHERE sa.story_id = ? AND a.status != 'failed' ORDER BY a.id`).all(story.id);
  const { voiceovers, media } = storyFilesByPurpose(story.id);

  res.attachment(`${dir}.zip`);
  const zip = archiver('zip', { store: true });
  zip.on('error', (e) => { console.error('ZIP failed:', e.message); res.destroy(e); });
  zip.pipe(res);

  let v = 0, p = 0;
  for (const a of assets) {
    const file = a.original_file || a.web_file;
    if (!file) continue;
    const ext = path.extname(file);
    const name = a.kind === 'video' ? `video-${++v}${ext}` : `photo-${++p}${ext}`;
    zip.file(assetPath(file), { name: `${dir}/${name}` });
  }
  const frame = story.featured_frame_id && db.prepare('SELECT file FROM frames WHERE id = ?').get(story.featured_frame_id);
  if (frame) zip.file(assetPath(frame.file), { name: `${dir}/main-photo.jpg` });
  voiceovers.forEach((m, i) => zip.file(path.join(UPLOAD_DIR, m.stored_name), { name: `${dir}/voiceover-${i + 1}${path.extname(m.stored_name)}` }));
  for (const m of media) zip.file(path.join(UPLOAD_DIR, m.stored_name), { name: `${dir}/other-files/${m.original_name}` });

  zip.append(block(`${lang.toUpperCase()} SCRIPT`, '', story.title, '', story.summary || null, story.summary ? '' : null, story.body), { name: `${dir}/script-${lang.toLowerCase()}.txt` });
  if (story.en_title || story.en_body) zip.append(block('ENGLISH SCRIPT', '', story.en_title, '', story.en_summary || null, story.en_summary ? '' : null, story.en_body), { name: `${dir}/script-english.txt` });
  zip.append(block('INSTAGRAM', '', 'Caption:', story.ig_caption, '', 'Hashtags:', story.hashtags, '', 'Keywords:', story.keywords), { name: `${dir}/instagram.txt` });
  zip.append(block('YOUTUBE', '', 'Title:', story.yt_title || story.en_title || story.title, '', 'Description:', story.yt_description || story.summary,
    '', 'Tags:', story.keywords, '', 'Hashtags:', story.hashtags), { name: `${dir}/youtube.txt` });
  zip.append(block(`Story #${story.id}: ${story.title}`, `Reporter: ${story.author_name}`, `Place: ${story.location}`, '',
    'Camera notes:', ...assets.map((a) => `- ${a.kind} by ${a.uploader_name}: ${a.note || a.original_name}${a.location ? ' (' + a.location + ')' : ''}`),
    '', ...videoTasks(story.id).map((t) => `${t.platform}: ${t.status}${t.note ? ' — ' + t.note : ''}`)), { name: `${dir}/README.txt` });
  await zip.finalize();
}));

const finalUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(/^video\//.test(file.mimetype) ? null : new HttpError(400, 'Please choose a video file.'), true),
});

// Optional: the editor uploads the finished Reel / YouTube video so others can post or archive it.
app.post('/api/video-desk/:id/final/:platform', requireVideoDesk, (req, _res, next) => {
  try { loadDeskStory(req); next(); } catch (e) { next(e); }
}, finalUpload.single('file'), h(async (req, res) => {
  const platform = req.params.platform === 'youtube' ? 'youtube' : 'instagram';
  const f = req.file;
  if (!f) throw new HttpError(400, 'No video received.');
  db.prepare(`INSERT INTO media (story_id, kind, original_name, stored_name, mime, size, purpose) VALUES (?,?,?,?,?,?,?)`)
    .run(Number(req.params.id), 'video', Buffer.from(f.originalname, 'latin1').toString('utf8'), f.filename, f.mimetype, f.size, `final_${platform}`);
  res.json({ ok: true });
}));

// ---------- Sites & publishing ----------

const SECRET_KEYS = ['appPassword', 'token'];
const parseSite = (row) => ({ ...row, config: JSON.parse(row.config), enabled: Boolean(row.enabled) });

function publicSite(site, admin) {
  if (!admin) {
    const { id, key, name, base_url, type, default_lang, default_media, enabled } = site;
    return { id, key, name, base_url, type, default_lang, default_media, enabled };
  }
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
  const { name, base_url, type, default_lang, default_media, enabled, config = {} } = req.body;
  const merged = { ...site.config };
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEYS.includes(k) && v === '••••••••') continue; // unchanged secret
    merged[k] = v;
  }
  db.prepare('UPDATE sites SET name = ?, base_url = ?, type = ?, default_lang = ?, default_media = ?, enabled = ?, config = ? WHERE id = ?').run(
    name ?? site.name, base_url ?? site.base_url, type ?? site.type, default_lang ?? site.default_lang,
    default_media === 'photo' || default_media === 'all' ? default_media : site.default_media,
    (enabled ?? site.enabled) ? 1 : 0, JSON.stringify(merged), site.id);
  res.json({ ok: true });
}));

app.post('/api/sites/:id/test', requireRole('admin'), h(async (req, res) => {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Site not found.');
  res.json({ message: await testConnection(parseSite(row)) });
}));

app.get('/api/settings', requireRole('admin'), (_req, res) => {
  res.json({ journalistsCanPublish: getSetting('journalistsCanPublish', false), storage: diskUsage(), ffmpeg: ffmpegAvailable });
});

app.patch('/api/settings', requireRole('admin'), (req, res) => {
  if ('journalistsCanPublish' in req.body) setSetting('journalistsCanPublish', Boolean(req.body.journalistsCanPublish));
  res.json({ ok: true });
});

app.post('/api/stories/:id/publish', requireWriter, h(async (req, res) => {
  if (!canPublish(req.user)) throw new HttpError(403, 'Only editors can publish. Submit the story for review instead.');
  const story = loadStory(req);
  const targets = Array.isArray(req.body.targets) ? req.body.targets : [];
  if (!targets.length) throw new HttpError(400, 'Choose at least one website.');
  const record = db.prepare(`INSERT INTO publications (story_id, site_id, lang, remote_status, ok, remote_id, remote_url, message, published_by)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const results = [];
  for (const t of targets) {
    const row = db.prepare('SELECT * FROM sites WHERE id = ? AND enabled = 1').get(Number(t.siteId));
    if (!row) { results.push({ siteId: t.siteId, ok: false, message: 'Site not found or disabled.' }); continue; }
    const site = parseSite(row);
    const lang = t.lang === 'en' ? 'en' : 'original';
    const status = t.status === 'draft' ? 'draft' : 'publish';
    const mode = t.media === 'photo' || t.media === 'all' ? t.media : site.default_media;
    try {
      const out = await publishTo(site, story, lang, publishMedia(story, mode), { status, youtubeUrl: mode === 'all' ? youtubeUrl(story.id) : '' });
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
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err instanceof HttpError || status < 500 ? err.message : `Server error: ${err.message}` });
});

startMediaWorker();

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
}

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`\nNewsdesk is running.\n  On this computer:   http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  Phones on same Wi-Fi: http://${ip}:${port}`);
    console.log('\nKeep this window open while people are using Newsdesk.\n');
  });
}
export default app;
