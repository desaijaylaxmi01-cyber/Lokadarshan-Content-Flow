// Reporter voiceover → video desk package → Instagram/YouTube done → website embeds YouTube.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newsdesk-vd-'));
const { default: app } = await import('../src/server.js');
const { cleanupOriginals } = await import('../src/media.js');
const { db } = await import('../src/db.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = (f) => path.join(process.env.DATA_DIR, f);
const posts = [];
const wpMedia = [];
let mock, server, base, admin, editor, reporter;

async function login(email, password) {
  const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const call = async (cookie, p, method = 'GET', body) => {
  const res = await fetch(base + p, { method, headers: { cookie, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/media')) { wpMedia.push(req.headers['content-type']); return res.end(JSON.stringify({ id: wpMedia.length, source_url: 'https://cdn.test/x' })); }
      if (req.url.endsWith('/posts')) { posts.push(JSON.parse(Buffer.concat(chunks))); return res.end(JSON.stringify({ id: 9, link: 'https://site.test/p', status: 'publish' })); }
      res.end('[]');
    });
  }).listen(0);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  admin = await login('admin@newsdesk.local', 'changeme123');
  await call(admin, '/users', 'POST', { name: 'Vinay Editor', email: 've@x.in', password: 'editor123', role: 'video_editor' });
  await call(admin, '/users', 'POST', { name: 'Ravi', email: 'r@x.in', password: 'reporter123', role: 'journalist' });
  editor = await login('ve@x.in', 'editor123');
  reporter = await login('r@x.in', 'reporter123');
  await call(admin, '/sites/1', 'PATCH', { type: 'wordpress', base_url: `http://localhost:${mock.address().port}`, config: { username: 'u', appPassword: 'p' } });
});

after(() => { server.close(); mock.close(); });

test('full video desk flow', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  // Cameraman-style upload (single chunk) of a short clip
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', tmp('clip.mp4')]);
  const data = fs.readFileSync(tmp('clip.mp4'));
  const { body: up } = await call(reporter, '/uploads', 'POST', { name: 'clip.mp4', size: data.length, mime: 'video/mp4' });
  await fetch(`${base}/uploads/${up.id}`, { method: 'PUT', headers: { cookie: reporter, 'Upload-Offset': '0' }, body: data });
  const { body: { id: assetId } } = await call(reporter, `/uploads/${up.id}/complete`, 'POST', { note: 'Gokak falls', location: 'Gokak' });
  for (let i = 0; i < 100 && (await call(reporter, `/assets/${assetId}`)).body.status === 'processing'; i++) await new Promise((r) => setTimeout(r, 100));

  const { body: { id } } = await call(reporter, '/stories', 'POST', {});
  await call(reporter, `/stories/${id}`, 'PATCH', {
    title: 'ಜಲಪಾತ', body: 'ಸುದ್ದಿ', en_title: 'Falls', en_body: 'News', location: 'Gokak',
    ig_caption: 'ಗೋಕಾಕ', hashtags: '#Gokak', keywords: 'gokak falls', yt_title: 'Gokak Falls in full flow', yt_description: 'Monsoon at Gokak',
  });
  await call(reporter, `/stories/${id}/assets`, 'POST', { assetId });

  // Voiceover recorded in the browser arrives as webm/opus and is converted to m4a
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'libopus', tmp('voice.webm')]);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(tmp('voice.webm'))], { type: 'audio/webm' }), 'voice.webm');
  const vo = await fetch(`${base}/stories/${id}/voiceover`, { method: 'POST', headers: { cookie: reporter }, body: form });
  assert.equal(vo.status, 200, await vo.text());
  const story = (await call(reporter, `/stories/${id}`)).body;
  assert.equal(story.voiceovers.length, 1);
  assert.equal(story.voiceovers[0].mime, 'audio/mp4');
  assert.equal(story.media.length, 0, 'voiceover is not a website file');

  // Video editor sees nothing until the reporter sends it to the desk
  assert.equal((await call(editor, '/stories')).status, 403);
  assert.equal((await call(editor, `/video-desk/${id}`)).status, 403);
  await call(reporter, `/stories/${id}/video-tasks`, 'POST', { platforms: ['instagram', 'youtube'] });
  const desk = (await call(editor, '/video-desk')).body;
  assert.equal(desk.length, 1);
  assert.deepEqual(desk[0].tasks.map((t) => t.status), ['todo', 'todo']);
  assert.equal(desk[0].voiceover_count, 1);
  assert.equal((await call(editor, `/stories/${id}`, 'PATCH', { title: 'x' })).status, 403);

  // One ZIP with video, main photo, voiceover and text files
  const zipRes = await fetch(`${base}/video-desk/${id}/package.zip`, { headers: { cookie: editor } });
  assert.equal(zipRes.status, 200);
  fs.writeFileSync(tmp('pkg.zip'), Buffer.from(await zipRes.arrayBuffer()));
  const names = spawnSync('python3', ['-c', 'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', tmp('pkg.zip')]).stdout.toString().trim().split('\n');
  assert.deepEqual(names.sort(), [`story-${id}/README.txt`, `story-${id}/instagram.txt`, `story-${id}/main-photo.jpg`, `story-${id}/script-english.txt`,
    `story-${id}/script-kannada.txt`, `story-${id}/video-1.mp4`, `story-${id}/voiceover-1.m4a`, `story-${id}/youtube.txt`].sort());
  const yt = spawnSync('python3', ['-c', 'import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8-sig"))', tmp('pkg.zip'), `story-${id}/youtube.txt`]).stdout.toString();
  assert.match(yt, /Gokak Falls in full flow/);

  // Camera original is kept while editing is pending, removed once done
  db.prepare(`UPDATE assets SET created_at = datetime('now', '-8 days') WHERE id = ?`).run(assetId);
  assert.equal(cleanupOriginals(7), 0);

  const [ig, ytTask] = desk[0].tasks;
  await call(editor, `/video-tasks/${ig.id}`, 'PATCH', { status: 'editing' });
  assert.equal((await call(editor, `/video-tasks/${ytTask.id}`, 'PATCH', { status: 'done', final_url: 'youtube.com/x' })).status, 400);
  await call(editor, `/video-tasks/${ytTask.id}`, 'PATCH', { status: 'done', final_url: 'https://youtu.be/abc123' });
  await call(editor, `/video-tasks/${ig.id}`, 'PATCH', { status: 'done', final_url: 'https://instagram.com/reel/xyz' });
  const tasks = (await call(editor, `/video-desk/${id}`)).body.video_tasks;
  assert.deepEqual(tasks.map((t) => [t.status, t.editor_name]), [['done', 'Vinay Editor'], ['done', 'Vinay Editor']]);
  assert.equal(cleanupOriginals(7), 1);

  // Website: main photo uploaded, raw video replaced by the YouTube embed
  const { body: { results } } = await call(admin, `/stories/${id}/publish`, 'POST', { targets: [{ siteId: 1, lang: 'original', media: 'all' }] });
  assert.equal(results[0].ok, true, JSON.stringify(results));
  assert.deepEqual(wpMedia, ['image/jpeg']);
  assert.match(posts[0].content, /wp:embed \{"url":"https:\/\/youtu.be\/abc123"/);

  const list = (await call(admin, '/stories')).body.find((s) => s.id === id);
  assert.deepEqual([list.ig_task, list.yt_task, list.published_site_ids], ['done', 'done', '1']);
});
