// Connectors that push a story to a news site's backend.
//   dryrun    – writes the exact payload to data/outbox/ (safe default for testing)
//   wordpress – WordPress REST API with an Application Password
//   webhook   – any custom CMS/CRM endpoint that accepts multipart/form-data
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, OUTBOX_DIR } from './db.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const paragraphs = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');

/** The language-specific copy of a story that gets published. */
export function articleFor(story, lang) {
  const en = lang === 'en';
  return {
    title: en ? story.en_title : story.title,
    summary: en ? story.en_summary : story.summary,
    body: en ? story.en_body : story.body,
    language: en ? 'en' : story.source_lang,
    category: story.category,
    tags: story.tags.split(',').map((t) => t.trim()).filter(Boolean),
    location: story.location,
  };
}

const filePath = (m) => m.path || path.join(UPLOAD_DIR, m.stored_name);

async function dryrun(site, story, article, media, opts) {
  const file = path.join(OUTBOX_DIR, `${site.key}-story${story.id}-${article.language}-${Date.now()}.json`);
  const payload = {
    site: site.name, status: opts.status, author: story.author_name, sourceStoryId: story.id, ...article,
    media: media.map((m) => ({ kind: m.kind, name: m.original_name, mime: m.mime, size: m.size, caption: m.caption, path: filePath(m) })),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return { remoteId: path.basename(file), url: '', message: `Dry run: payload saved to ${path.relative(process.cwd(), file)}` };
}

// ---------- WordPress ----------

function wpClient(site) {
  const cfg = site.config;
  if (!site.base_url || !cfg.username || !cfg.appPassword) {
    throw new Error('WordPress connector needs Site URL, username and Application Password (Admin → Sites).');
  }
  const base = site.base_url.replace(/\/$/, '') + '/wp-json/wp/v2';
  const auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.appPassword.replace(/\s+/g, '')}`).toString('base64');
  return async (endpoint, init = {}) => {
    const res = await fetch(base + endpoint, { ...init, headers: { Authorization: auth, ...init.headers } });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) throw new Error(`WordPress ${endpoint} → ${res.status}: ${json?.message || text.slice(0, 200)}`);
    return json;
  };
}

async function wpTermIds(wp, taxonomy, names) {
  const ids = [];
  for (const name of names) {
    const found = await wp(`/${taxonomy}?search=${encodeURIComponent(name)}&per_page=20`);
    const match = found.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (match) { ids.push(match.id); continue; }
    const created = await wp(`/${taxonomy}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    ids.push(created.id);
  }
  return ids;
}

async function wordpress(site, story, article, media, opts) {
  const wp = wpClient(site);
  const uploaded = [];
  for (const m of media) {
    const blob = await fs.openAsBlob(filePath(m), { type: m.mime });
    const res = await wp('/media', {
      method: 'POST',
      headers: { 'Content-Type': m.mime, 'Content-Disposition': `attachment; filename="${encodeURIComponent(m.original_name)}"` },
      body: blob,
    });
    if (m.caption) {
      await wp(`/media/${res.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: m.caption, alt_text: m.caption }),
      });
    }
    uploaded.push({ ...m, wpId: res.id, url: res.source_url });
  }

  const images = uploaded.filter((m) => m.kind === 'image');
  const featured = images.shift();
  const html = [];
  if (article.location) html.push(`<p><strong>${escapeHtml(article.location)}:</strong></p>`);
  html.push(paragraphs(article.body));
  for (const m of uploaded) {
    const cap = m.caption ? `<figcaption>${escapeHtml(m.caption)}</figcaption>` : '';
    if (m.kind === 'video') html.push(`<figure class="wp-block-video"><video controls src="${m.url}"></video>${cap}</figure>`);
    else if (m.kind === 'audio') html.push(`<figure class="wp-block-audio"><audio controls src="${m.url}"></audio>${cap}</figure>`);
    else if (m.kind === 'image' && m !== featured) html.push(`<figure class="wp-block-image"><img src="${m.url}" alt="${escapeHtml(m.caption)}">${cap}</figure>`);
  }
  const docs = uploaded.filter((m) => m.kind === 'document');
  if (docs.length) {
    html.push('<h4>Documents &amp; data</h4><ul>' +
      docs.map((m) => `<li><a href="${m.url}">${escapeHtml(m.caption || m.original_name)}</a></li>`).join('') + '</ul>');
  }

  const post = {
    title: article.title,
    excerpt: article.summary,
    content: html.join('\n'),
    status: opts.status,
  };
  if (featured) post.featured_media = featured.wpId;
  if (article.category) post.categories = await wpTermIds(wp, 'categories', [article.category]);
  if (article.tags.length) post.tags = await wpTermIds(wp, 'tags', article.tags);
  if (site.config.langParam) post.lang = article.language; // Polylang / WPML language field

  const created = await wp('/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
  return { remoteId: String(created.id), url: created.link, message: `WordPress post #${created.id} (${created.status})` };
}

// ---------- Generic CRM / webhook ----------

async function webhook(site, story, article, media, opts) {
  const cfg = site.config;
  if (!cfg.endpoint) throw new Error('Webhook connector needs an endpoint URL (Admin → Sites).');
  const form = new FormData();
  form.append('story', JSON.stringify({
    ...article, status: opts.status, author: story.author_name, sourceStoryId: story.id,
    media: media.map((m, i) => ({ field: `file${i}`, kind: m.kind, name: m.original_name, caption: m.caption })),
  }));
  for (const [i, m] of media.entries()) {
    form.append(`file${i}`, await fs.openAsBlob(filePath(m), { type: m.mime }), m.original_name);
  }
  const headers = {};
  if (cfg.token) headers[cfg.authHeader || 'Authorization'] = cfg.authHeader ? cfg.token : `Bearer ${cfg.token}`;
  const res = await fetch(cfg.endpoint, { method: 'POST', headers, body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`CRM responded ${res.status}: ${text.slice(0, 200)}`);
  let json = {};
  try { json = JSON.parse(text); } catch { /* endpoint may not return JSON */ }
  return { remoteId: String(json.id ?? ''), url: json.url || json.link || '', message: `Sent to CRM (${res.status})` };
}

const CONNECTORS = { dryrun, wordpress, webhook };

export async function publishTo(site, story, lang, media, opts) {
  const article = articleFor(story, lang);
  if (!article.title || !article.body) {
    throw new Error(lang === 'en' ? 'English version is empty. Translate the story first.' : 'Story title and body are required.');
  }
  return CONNECTORS[site.type](site, story, article, media, opts);
}

export async function testConnection(site) {
  if (site.type === 'dryrun') return 'Dry-run mode: nothing is sent; payloads are written to data/outbox/.';
  if (site.type === 'wordpress') {
    const me = await wpClient(site)('/users/me?context=edit');
    return `Connected to WordPress as "${me.name}" (roles: ${(me.roles || []).join(', ')}).`;
  }
  if (!site.config.endpoint) throw new Error('No endpoint configured.');
  return `Webhook endpoint configured: ${site.config.endpoint} (sent on publish).`;
}
