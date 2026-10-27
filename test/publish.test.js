// End-to-end test of the WordPress and CRM connectors against a mock backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newsdesk-'));
const { default: app } = await import('../src/server.js');

const received = { media: [], posts: [], terms: [], webhook: null, auth: [] };
let mock, server, base, mockUrl, cookie;

function readBody(req) {
  return new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    const body = await readBody(req);
    received.auth.push(req.headers.authorization);
    const send = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/wp-json/wp/v2/media' && req.method === 'POST') {
      received.media.push({ type: req.headers['content-type'], disp: req.headers['content-disposition'], size: body.length });
      return send({ id: 100 + received.media.length, source_url: `https://cdn.test/f${received.media.length}` });
    }
    if (/^\/wp-json\/wp\/v2\/media\/\d+$/.test(url.pathname)) return send({});
    if (/\/(categories|tags)$/.test(url.pathname)) {
      if (req.method === 'GET') return send([]);
      received.terms.push(JSON.parse(body).name);
      return send({ id: 500 + received.terms.length });
    }
    if (url.pathname === '/wp-json/wp/v2/posts') {
      const post = JSON.parse(body);
      received.posts.push(post);
      return send({ id: 77, link: 'https://site.test/heavy-rain', status: post.status });
    }
    if (url.pathname === '/wp-json/wp/v2/users/me') return send({ name: 'desk', roles: ['editor'] });
    if (url.pathname === '/crm/articles') {
      received.webhook = { type: req.headers['content-type'], body: body.toString('latin1') };
      return send({ id: 'crm-9', url: 'https://crm.test/a/9' });
    }
    res.statusCode = 404; res.end('nope');
  }).listen(0);
  server = app.listen(0);
  mockUrl = `http://localhost:${mock.address().port}`;
  base = `http://localhost:${server.address().port}/api`;
  const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@newsdesk.local', password: 'changeme123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => { server.close(); mock.close(); });

const call = async (p, method = 'GET', body) => {
  const res = await fetch(base + p, { method, headers: { cookie, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return res.json();
};

test('publishes to WordPress and a custom CRM with media', async () => {
  await call('/sites/1', 'PATCH', { type: 'wordpress', base_url: mockUrl, config: { username: 'desk', appPassword: 'abcd efgh' } });
  await call('/sites/2', 'PATCH', { type: 'webhook', config: { endpoint: mockUrl + '/crm/articles', token: 'secret' } });
  assert.match((await call('/sites/1/test', 'POST')).message, /Connected to WordPress as "desk"/);
  assert.equal((await call('/sites')).find((s) => s.id === 2).config.token, '••••••••');

  const { id } = await call('/stories', 'POST', {});
  await call(`/stories/${id}`, 'PATCH', {
    title: 'ಮಳೆ', body: 'ಮೊದಲ ಪ್ಯಾರಾ\n\nಎರಡನೇ <ಪ್ಯಾರಾ>', category: 'Belagavi', tags: 'rain, weather', location: 'Belagavi',
    en_title: 'Heavy rain', en_summary: 'Rain lashed the city.', en_body: 'First para.\n\nSecond para.',
  });
  const form = new FormData();
  form.append('files', new Blob([Buffer.alloc(2048)], { type: 'image/jpeg' }), 'photo.jpg');
  form.append('files', new Blob([Buffer.alloc(4096)], { type: 'video/mp4' }), 'ವಿಡಿಯೋ.mp4');
  form.append('files', new Blob(['a,b\n1,2'], { type: 'text/csv' }), 'data.csv');
  const up = await (await fetch(`${base}/stories/${id}/media`, { method: 'POST', headers: { cookie }, body: form })).json();
  assert.equal(up.count, 3);
  const story = await call(`/stories/${id}`);
  assert.equal(story.media[1].original_name, 'ವಿಡಿಯೋ.mp4');

  const { results } = await call(`/stories/${id}/publish`, 'POST', {
    targets: [{ siteId: 1, lang: 'original', status: 'publish' }, { siteId: 2, lang: 'en', status: 'draft' }],
  });
  assert.deepEqual(results.map((r) => r.ok), [true, true], JSON.stringify(results));
  assert.equal(results[0].url, 'https://site.test/heavy-rain');
  assert.equal(results[1].remoteId, 'crm-9');

  // WordPress: 3 media uploads with basic auth, featured image, embedded video, escaped text, terms created
  assert.equal(received.media.length, 3);
  assert.equal(received.auth[0], 'Basic ' + Buffer.from('desk:abcdefgh').toString('base64'));
  const post = received.posts[0];
  assert.equal(post.title, 'ಮಳೆ');
  assert.equal(post.featured_media, 101);
  assert.match(post.content, /<video controls src="https:\/\/cdn.test\/f2">/);
  assert.match(post.content, /&lt;ಪ್ಯಾರಾ&gt;/);
  assert.match(post.content, /data\.csv/);
  assert.deepEqual(received.terms, ['Belagavi', 'rain', 'weather']);

  // CRM: multipart with English story JSON and the files, bearer token
  assert.match(received.webhook.type, /multipart\/form-data/);
  assert.match(received.webhook.body, /"title":"Heavy rain"/);
  assert.match(received.webhook.body, /name="file1"/);
  assert.ok(received.auth.includes('Bearer secret'));

  assert.equal((await call(`/stories/${id}`)).status, 'published');
});

test('English publish is refused when the story is not translated', async () => {
  const { id } = await call('/stories', 'POST', {});
  await call(`/stories/${id}`, 'PATCH', { title: 'x', body: 'y' });
  const { results } = await call(`/stories/${id}/publish`, 'POST', { targets: [{ siteId: 1, lang: 'en' }] });
  assert.equal(results[0].ok, false);
  assert.match(results[0].message, /Translate the story first/);
});
