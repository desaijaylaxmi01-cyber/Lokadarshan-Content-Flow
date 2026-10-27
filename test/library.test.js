// Cameraman → media library → reporter picks video + screenshot → publish. Uses real ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newsdesk-lib-'));
const { default: app } = await import('../src/server.js');
const { cleanupOriginals } = await import('../src/media.js');
const { db } = await import('../src/db.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const wpMedia = [];
let mock, server, base, admin, camera;

async function login(email, password) {
  const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const call = async (cookie, p, method = 'GET', body) => {
  const res = await fetch(base + p, { method, headers: { cookie, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const waitReady = async (id) => {
  for (let i = 0; i < 200; i++) {
    const { body } = await call(camera, `/assets/${id}`);
    if (body.status !== 'processing') return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('processing timed out');
};

async function uploadFile(cookie, file, mime, note) {
  const data = fs.readFileSync(file);
  const { body: init } = await call(cookie, '/uploads', 'POST', { name: path.basename(file), size: data.length, mime });
  const chunk = Math.ceil(data.length / 3);
  let offset = 0;
  for (let i = 0; offset < data.length; i++) {
    const res = await fetch(`${base}/uploads/${init.id}`, {
      method: 'PUT', headers: { cookie, 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
      body: data.subarray(offset, offset + chunk),
    });
    assert.equal(res.status, 200);
    offset = (await res.json()).received;
    if (i === 0) {
      // Simulate a dropped connection: client resends from a stale offset, server says where to resume.
      const stale = await fetch(`${base}/uploads/${init.id}`, { method: 'PUT', headers: { cookie, 'Upload-Offset': '0' }, body: data.subarray(0, 10) });
      assert.equal(stale.status, 409);
      assert.equal((await call(cookie, `/uploads/${init.id}`)).body.received, offset);
    }
  }
  const { body } = await call(cookie, `/uploads/${init.id}/complete`, 'POST', { note, location: 'Gokak' });
  return body.id;
}

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/media')) {
        wpMedia.push({ type: req.headers['content-type'], disp: decodeURIComponent(req.headers['content-disposition']) });
        return res.end(JSON.stringify({ id: wpMedia.length, source_url: `https://cdn.test/${wpMedia.length}` }));
      }
      if (req.url.endsWith('/posts')) return res.end(JSON.stringify({ id: 1, link: 'https://site.test/p', status: 'publish' }));
      res.end('[]');
    });
  }).listen(0);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  admin = await login('admin@newsdesk.local', 'changeme123');
  await call(admin, '/users', 'POST', { name: 'Kiran Camera', email: 'cam@x.in', password: 'camera123', role: 'cameraman' });
  camera = await login('cam@x.in', 'camera123');
  await call(admin, '/sites/1', 'PATCH', { type: 'wordpress', base_url: `http://localhost:${mock.address().port}`, config: { username: 'u', appPassword: 'p' } });
});

after(() => { server.close(); mock.close(); });

test('cameraman cannot open stories', async () => {
  assert.equal((await call(camera, '/stories')).status, 403);
  assert.equal((await call(camera, '/uploads', 'POST', { name: 'a.pdf', size: 10, mime: 'application/pdf' })).status, 400);
});

test('video upload → screenshots → story → publish', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const video = path.join(process.env.DATA_DIR, 'clip.mov');
  const made = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video]);
  assert.equal(made.status, 0, made.stderr?.toString());

  const id = await uploadFile(camera, video, 'video/quicktime', 'ಗೋಕಾಕ ಜಲಪಾತ');
  const asset = await waitReady(id);
  assert.equal(asset.status, 'ready', asset.error);
  assert.equal(asset.frames.length, 10);
  assert.ok(asset.duration > 11 && asset.duration < 13);

  // Web version is portrait 720x1280, streamable with range requests
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
    path.join(process.env.DATA_DIR, 'library', asset.web_file)]).stdout.toString().trim();
  assert.equal(probe, '720,1280');
  const ranged = await fetch(`${base}/assets/${id}/web`, { headers: { cookie: camera, Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);

  // Library search finds it by Kannada note
  const lib = (await call(admin, `/assets?q=${encodeURIComponent('ಜಲಪಾತ')}`)).body;
  assert.equal(lib.length, 1);
  assert.ok(lib[0].thumb_frame_id);

  // Reporter tags the video; middle screenshot becomes the photo automatically
  const { body: { id: storyId } } = await call(admin, '/stories', 'POST', {});
  await call(admin, `/stories/${storyId}`, 'PATCH', { title: 'ಜಲಪಾತ', body: 'ಸುದ್ದಿ', en_title: 'Falls', en_body: 'News', hashtags: '#Gokak #Belagavi', ig_caption: 'Gokak falls' });
  await call(admin, `/stories/${storyId}/assets`, 'POST', { assetId: id });
  let story = (await call(admin, `/stories/${storyId}`)).body;
  assert.equal(story.featured_frame_id, asset.frames[5].id);
  assert.equal(story.hashtags, '#Gokak #Belagavi');

  // "Use this frame" at 3.2s, then pick it
  const custom = (await call(admin, `/assets/${id}/frames`, 'POST', { t: 3.2 })).body;
  await call(admin, `/stories/${storyId}`, 'PATCH', { featured_frame_id: custom.id });
  story = (await call(admin, `/stories/${storyId}`)).body;
  assert.equal(story.featured_frame_id, custom.id);

  // Lokadarshan: photo + video; Belagavi Insider (dry run, photo only)
  const { body: { results } } = await call(admin, `/stories/${storyId}/publish`, 'POST', {
    targets: [{ siteId: 1, lang: 'original', media: 'all' }, { siteId: 2, lang: 'en' }],
  });
  assert.deepEqual(results.map((r) => r.ok), [true, true], JSON.stringify(results));
  assert.deepEqual(wpMedia.map((m) => m.type), ['image/jpeg', 'video/mp4']);
  assert.match(wpMedia[0].disp, /story-\d+-photo\.jpg/);
  const outbox = fs.readdirSync(path.join(process.env.DATA_DIR, 'outbox')).find((f) => f.startsWith('belagavi'));
  const payload = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'outbox', outbox)));
  assert.deepEqual(payload.media.map((m) => m.kind), ['image']);

  // Housekeeping: originals removed after retention, web version kept
  db.prepare(`UPDATE assets SET created_at = datetime('now', '-8 days') WHERE id = ?`).run(id);
  assert.equal(cleanupOriginals(7), 1);
  const after = (await call(admin, `/assets/${id}`)).body;
  assert.equal(after.original_file, null);
  assert.equal((await fetch(`${base}/assets/${id}/original`, { headers: { cookie: admin } })).status, 200);
});
