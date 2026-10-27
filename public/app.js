// Newsdesk front end — plain JS, hash routing.
import { esc, api, toast, fmtSize, fmtDate, badge, CATEGORIES, guard, setUnauthorizedHandler, copyText } from './lib.js';
import { renderUpload, renderLibrary, renderLinked } from './library.js';
import { renderVoiceover, renderVideoTasks, renderDesk, renderPackage } from './videodesk.js';
const $app = document.getElementById('app');
let me = null;
setUnauthorizedHandler(() => { me = null; renderLogin(); });

// ---------- shell ----------

async function boot() {
  try {
    me = await api('/me');
  } catch { return; }
  document.getElementById('topbar').hidden = false;
  document.getElementById('user-name').textContent = `${me.user.name} · ${me.user.role}`;
  const role = me.user.role;
  const show = {
    upload: role !== 'video_editor',
    library: role !== 'cameraman',
    stories: ['journalist', 'editor', 'admin'].includes(role),
    new: ['journalist', 'editor', 'admin'].includes(role),
    desk: ['video_editor', 'editor', 'admin'].includes(role),
    admin: role === 'admin',
  };
  for (const [n, visible] of Object.entries(show)) document.querySelector(`[data-nav=${n}]`).hidden = !visible;
  route();
}

function renderLogin() {
  document.getElementById('topbar').hidden = true;
  $app.innerHTML = `
    <div class="login-wrap"><form class="card login stack" id="login-form">
      <div><div class="brand"><span class="brand-mark">ND</span> Newsdesk</div>
      <p class="hint">Lokadarshan News · Belagavi Insider — reporter portal</p></div>
      <div><label for="email">Email</label><input type="email" id="email" required autocomplete="username"></div>
      <div><label for="password">Password</label><input type="password" id="password" required autocomplete="current-password"></div>
      <button class="primary" type="submit">Sign in</button>
    </form></div>`;
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    await guard(e.submitter, async () => {
      await api('/login', { method: 'POST', body: { email: email.value, password: password.value } });
      await boot();
    });
  };
}

document.getElementById('btn-logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; renderLogin(); };
document.getElementById('btn-password').onclick = () => {
  const d = document.createElement('dialog');
  d.innerHTML = `<form class="stack" method="dialog">
    <h2>Change password</h2>
    <div><label>Current password</label><input type="password" name="current" required></div>
    <div><label>New password (8+ characters)</label><input type="password" name="next" minlength="8" required></div>
    <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.append(d);
  d.showModal();
  d.querySelector('form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'save') return d.remove();
    e.preventDefault();
    const f = new FormData(e.target);
    await guard(e.submitter, async () => {
      await api('/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      toast('Password changed'); d.remove();
    });
  };
};

function route() {
  if (!me) return;
  let hash = location.hash.slice(1) || '/';
  if (me.user.role === 'cameraman') hash = '/upload';
  if (me.user.role === 'video_editor' && !/^\/(video|library)/.test(hash)) hash = '/video-desk';
  const nav = hash.startsWith('/video') ? 'desk' : { '/admin': 'admin', '/new': 'new', '/upload': 'upload', '/library': 'library' }[hash] || 'stories';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  const m = hash.match(/^\/story\/(\d+)/);
  if (hash === '/upload') return renderUpload($app);
  if (hash === '/video-desk') return renderDesk($app);
  const pkg = hash.match(/^\/video\/(\d+)/);
  if (pkg) return renderPackage($app, Number(pkg[1]));
  if (hash === '/library') return renderLibrary($app, me);
  if (hash === '/new') return newStory();
  if (m) return renderEditor(Number(m[1]));
  if (hash === '/admin' && me.user.role === 'admin') return renderAdmin();
  return renderList();
}
window.addEventListener('hashchange', route);

// ---------- story list ----------

let listState = { status: '', q: '', mine: false };

async function renderList() {
  const editor = me.user.role !== 'journalist';
  $app.innerHTML = `
    <div class="page-head">
      <h1>${editor ? 'Newsroom stories' : 'My stories'}</h1>
      <div class="row">
        <input type="text" id="search" placeholder="Search headlines…" value="${esc(listState.q)}" style="width:220px">
        ${editor ? `<label class="row" style="margin:0;font-weight:500"><input type="checkbox" id="mine" ${listState.mine ? 'checked' : ''}> Only mine</label>` : ''}
        <a class="btn primary" href="#/new" style="background:var(--accent);color:var(--accent-text);border-color:var(--accent)">+ New story</a>
      </div>
    </div>
    <div class="tabs" id="tabs">
      ${['', 'draft', 'submitted', 'published', 'rejected'].map((s) =>
        `<button data-s="${s}" class="${listState.status === s ? 'active' : ''}">${s ? s[0].toUpperCase() + s.slice(1) : 'All'}${s === 'submitted' && editor ? ' (needs review)' : ''}</button>`).join('')}
    </div>
    <div class="card" style="padding:0;overflow-x:auto" id="list"><div class="empty">Loading…</div></div>`;

  document.getElementById('tabs').onclick = (e) => {
    if (e.target.dataset.s === undefined) return;
    listState.status = e.target.dataset.s; renderList();
  };
  const search = document.getElementById('search');
  search.oninput = () => { clearTimeout(search.t); search.t = setTimeout(() => { listState.q = search.value; loadList(); }, 300); };
  const mine = document.getElementById('mine');
  if (mine) mine.onchange = () => { listState.mine = mine.checked; loadList(); };
  loadList();
}

let siteNames = null;
function outletChips(s) {
  const published = new Set(String(s.published_site_ids || '').split(',').filter(Boolean).map(Number));
  const task = (label, st) => `<span class="chip ${st === 'done' ? 'on' : st ? 'wip' : ''}" title="${label}: ${st || 'not sent'}">${label}</span>`;
  return task('IG', s.ig_task) + task('YT', s.yt_task)
    + siteNames.map((x) => `<span class="chip ${published.has(x.id) ? 'on' : ''}" title="${esc(x.name)}${published.has(x.id) ? ': published' : ''}">${esc(x.short)}</span>`).join('');
}

async function loadList() {
  const qs = new URLSearchParams({ status: listState.status, q: listState.q, mine: listState.mine ? '1' : '' });
  siteNames ??= (await api('/sites')).map((x) => ({ id: x.id, name: x.name, short: x.name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 3) }));
  const stories = await api('/stories?' + qs);
  const el = document.getElementById('list');
  if (!el) return;
  if (!stories.length) {
    el.innerHTML = `<div class="empty">No stories here yet. <a href="#/new">Start a new story</a>.</div>`;
    return;
  }
  el.innerHTML = `<table><thead><tr><th class="thumb-col"></th><th>Story</th><th class="hide-sm">Reporter</th><th>Status</th><th>Outlets</th><th class="hide-sm">Files</th><th class="hide-sm">Updated</th></tr></thead><tbody>
    ${stories.map((s) => `<tr data-id="${s.id}">
      <td class="thumb-col">${s.featured_frame_id ? `<img src="/api/frames/${s.featured_frame_id}/file" alt="" loading="lazy">`
        : s.featured_asset_id ? `<img src="/api/assets/${s.featured_asset_id}/web" alt="" loading="lazy">` : '<div class="no-thumb"></div>'}</td>
      <td><div class="story-title">${esc(s.title || '(untitled)')}</div>
        <div class="story-sub">${s.en_title ? 'EN: ' + esc(s.en_title) : 'Not translated'}${s.category ? ' · ' + esc(s.category) : ''}</div></td>
      <td class="hide-sm">${esc(s.author_name)}</td>
      <td>${badge(s.status)}</td>
      <td class="chips">${outletChips(s)}</td>
      <td class="hide-sm">${s.media_count + s.asset_count}</td>
      <td class="hide-sm story-sub">${fmtDate(s.updated_at)}</td></tr>`).join('')}
  </tbody></table>
  <div class="hint outlet-key">Outlets: <span class="chip">IG</span> Instagram <span class="chip">YT</span> YouTube
    ${siteNames.map((x) => `<span class="chip">${esc(x.short)}</span> ${esc(x.name)}`).join(' ')}
    · <span class="chip wip">blue</span> with video desk · <span class="chip on">green</span> done / published</div>`;
  el.querySelector('tbody').onclick = (e) => {
    const tr = e.target.closest('tr');
    if (tr) location.hash = `#/story/${tr.dataset.id}`;
  };
}

async function newStory() {
  const { id } = await api('/stories', { method: 'POST', body: { source_lang: 'kn' } });
  location.replace(`#/story/${id}`);
}

// ---------- story editor ----------

let saveTimer = null;
let pending = {};

async function renderEditor(id) {
  const [story, sites] = await Promise.all([api(`/stories/${id}`), api('/sites')]);
  const editor = me.user.role !== 'journalist';
  const locked = !editor && story.status === 'published';
  const ro = locked ? 'readonly' : '';
  const langOpts = Object.entries(me.languages).map(([k, v]) => `<option value="${k}" ${story.source_lang === k ? 'selected' : ''}>${v}</option>`).join('');

  $app.innerHTML = `
    <div class="page-head">
      <div><a href="#/" class="hint" style="text-decoration:none">← All stories</a>
        <h1>${esc(story.title || 'New story')} ${badge(story.status)}</h1>
        <div class="hint">By ${esc(story.author_name)} · created ${fmtDate(story.created_at)}</div></div>
      <div class="row"><span class="save-state" id="save-state">All changes saved</span>
        ${(me.user.role === 'admin' || story.status === 'draft') ? '<button class="danger" id="btn-delete">Delete</button>' : ''}</div>
    </div>
    ${story.status === 'rejected' && story.editor_note ? `<div class="note" style="margin-bottom:16px"><strong>Editor's note:</strong> ${esc(story.editor_note)}</div>` : ''}
    ${locked ? `<div class="note" style="margin-bottom:16px">This story is published. Ask an editor to make changes.</div>` : ''}

    <div class="editor-layout">
      <div class="stack">
        <section class="card stack" id="linked"></section>
        <div class="grid-2">
          <section class="card lang-panel orig stack">
            <div class="panel-head"><h2>Original script</h2>
              <select data-f="source_lang" style="width:auto" ${locked ? 'disabled' : ''}>${langOpts}</select></div>
            <div><label>Headline</label><input type="text" data-f="title" value="${esc(story.title)}" ${ro}></div>
            <div><label>Summary / standfirst</label><textarea data-f="summary" rows="2" ${ro}>${esc(story.summary)}</textarea></div>
            <div><label>Story script</label><textarea class="script" data-f="body" ${ro} placeholder="Type or paste the full story here…">${esc(story.body)}</textarea></div>
            ${locked ? '' : `<div class="hint">Writing with ChatGPT, Gemini or Claude? <button class="link" id="btn-ai-prompt" style="color:var(--info)">Copy a ready-made prompt</button>, paste it there, then paste the answer back here.</div>`}
          </section>
          <section class="card lang-panel en stack">
            <div class="panel-head"><h2>English version</h2>
              <button class="primary" id="btn-translate" ${locked ? 'disabled' : ''} title="${me.translationAvailable ? '' : 'Translation not configured on the server'}">Translate to English</button></div>
            <div class="hint" id="tr-state">${story.translated_at ? 'Auto-translated ' + fmtDate(story.translated_at) + ' — review and edit before publishing.' : 'Click “Translate to English”, then review the text. You can also type it yourself.'}</div>
            <div><label>English headline</label><input type="text" data-f="en_title" value="${esc(story.en_title)}" ${ro}></div>
            <div><label>English summary</label><textarea data-f="en_summary" rows="2" ${ro}>${esc(story.en_summary)}</textarea></div>
            <div><label>English story</label><textarea class="script" data-f="en_body" ${ro}>${esc(story.en_body)}</textarea></div>
          </section>
        </div>

        <section class="card stack" id="voiceover"></section>

        <section class="card stack">
          <h2>Other files <span class="hint" style="font-weight:400">— documents, data, audio, extra photos</span></h2>
          ${locked ? '' : `<div class="dropzone" id="dropzone">
            <strong>Drop files here</strong> or click to choose<br>
            <span class="hint">Photos, audio clips, video, PDFs, spreadsheets, CSV/data files</span>
            <input type="file" id="file-input" multiple hidden accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.json,.zip,.odt,.ods">
            <div class="progress" id="progress" hidden><div></div></div>
            <div class="hint" id="progress-text"></div></div>`}
          <div class="media-list" id="media">${story.media.length ? '' : '<div class="hint">No files attached yet.</div>'}</div>
        </section>
      </div>

      <aside class="sidebar stack">
        <section class="card stack">
          <h2>Details</h2>
          <div><label>Category</label><input type="text" data-f="category" list="cats" value="${esc(story.category)}" ${ro}>
            <datalist id="cats">${CATEGORIES.map((c) => `<option value="${c}">`).join('')}</datalist></div>
          <div><label>Tags</label><input type="text" data-f="tags" value="${esc(story.tags)}" placeholder="comma, separated" ${ro}></div>
          <div><label>Dateline / location</label><input type="text" data-f="location" value="${esc(story.location)}" placeholder="e.g. Belagavi" ${ro}></div>
        </section>
        <section class="card stack">
          <h2>Instagram &amp; YouTube</h2>
          <div><label>Instagram caption</label><textarea data-f="ig_caption" rows="3" ${ro}>${esc(story.ig_caption)}</textarea></div>
          <div><label>Keywords</label><input type="text" data-f="keywords" value="${esc(story.keywords)}" placeholder="belagavi rain, gokak falls" ${ro}></div>
          <div><label>Hashtags</label><input type="text" data-f="hashtags" value="${esc(story.hashtags)}" placeholder="#Belagavi #Karnataka" ${ro}></div>
          <div class="row"><button id="btn-copy-ig">📋 Copy caption + hashtags</button></div>
          <div><label>YouTube title</label><input type="text" data-f="yt_title" value="${esc(story.yt_title)}" placeholder="Short, searchable title" ${ro}></div>
          <div><label>YouTube description</label><textarea data-f="yt_description" rows="3" ${ro}>${esc(story.yt_description)}</textarea></div>
          <div class="hint">YouTube tags use the keywords above.</div>
        </section>
        <section class="card stack" id="video-tasks"></section>
        <section class="card stack" id="workflow"></section>
        ${story.publications.length ? `<section class="card"><h2>Publishing history</h2><ul class="history" style="padding-left:18px;margin:0">
          ${story.publications.map((p) => `<li><strong>${esc(p.site_name)}</strong> (${p.lang === 'en' ? 'English' : 'original'}, ${esc(p.remote_status)}) —
            <span style="color:var(${p.ok ? '--ok' : '--accent'})">${p.ok ? 'sent' : 'failed'}</span>
            ${p.remote_url ? `· <a href="${esc(p.remote_url)}" target="_blank" rel="noopener">view</a>` : ''}
            <div class="hint">${esc(p.message)} · ${esc(p.published_by_name || '')} · ${fmtDate(p.created_at)}</div></li>`).join('')}
          </ul></section>` : ''}
      </aside>
    </div>`;

  // Autosave on edit
  pending = {};
  $app.querySelectorAll('[data-f]').forEach((el) => {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      pending[el.dataset.f] = el.value;
      document.getElementById('save-state').textContent = 'Saving…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(id), 800);
    });
  });

  renderMedia(story, locked);
  renderWorkflow(story, sites, editor);
  const linkedEl = document.getElementById('linked');
  const voiceEl = document.getElementById('voiceover');
  const tasksEl = document.getElementById('video-tasks');
  // Re-render the media sections only, so text being typed elsewhere is not disturbed.
  const refreshParts = async () => {
    await flush(id);
    const fresh = await api(`/stories/${id}`);
    for (const k of ['assets', 'featured_frame_id', 'featured_asset_id', 'voiceovers', 'video_tasks']) story[k] = fresh[k];
    if (!document.body.contains(linkedEl)) return;
    renderLinked(linkedEl, story, locked, refreshParts);
    renderVoiceover(voiceEl, story, locked, refreshParts);
    renderVideoTasks(tasksEl, story, refreshParts);
  };
  renderLinked(linkedEl, story, locked, refreshParts);
  renderVoiceover(voiceEl, story, locked, refreshParts);
  renderVideoTasks(tasksEl, story, refreshParts);

  document.getElementById('btn-copy-ig').onclick = () => {
    const v = (f) => $app.querySelector(`[data-f=${f}]`).value.trim();
    copyText([v('ig_caption') || v('title'), v('hashtags')].filter(Boolean).join('\n\n'), 'Caption copied — paste it in Instagram');
  };
  document.getElementById('btn-ai-prompt')?.addEventListener('click', () => {
    const v = (f) => $app.querySelector(`[data-f=${f}]`).value.trim();
    const facts = story.assets.map((a) => [a.note, a.location].filter(Boolean).join(' — ')).filter(Boolean);
    const lang = me.languages[v('source_lang')] || 'Kannada';
    copyText(`You are a news reporter for Lokadarshan News, a ${lang} news website in Belagavi, Karnataka.
Write a news story in ${lang} from the facts below. Use only these facts; do not invent names, numbers or quotes.

Give me:
1. Headline (${lang})
2. News script (${lang}, 4–8 short paragraphs)
3. Instagram caption (${lang}, 2–3 lines)
4. YouTube title (under 70 characters) and YouTube description (3–4 lines)
5. 5 SEO keywords (English)
6. 10 hashtags
7. A 45–60 second voiceover script (${lang}) for the Instagram Reel

Place: ${v('location') || '[place]'}
Date: ${new Date().toLocaleDateString('en-IN', { dateStyle: 'long' })}
Facts / cameraman notes:
${facts.length ? facts.map((f) => '- ' + f).join('\n') : '- [write what happened, who, when, where]'}
${v('body') ? '\nMy draft so far:\n' + v('body') : ''}`, 'Prompt copied — paste it into ChatGPT, Gemini or Claude');
  });

  document.getElementById('btn-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this story and all its files? This cannot be undone.')) return;
    await guard(null, async () => { await api(`/stories/${id}`, { method: 'DELETE' }); toast('Story deleted'); location.hash = '#/'; });
  });

  document.getElementById('btn-translate').onclick = async (e) => {
    const btn = e.currentTarget;
    if (!me.translationAvailable) return toast('Translation is not configured. Ask the admin to set ANTHROPIC_API_KEY on the server.', true);
    const hasEnglish = $app.querySelector('[data-f=en_body]').value.trim();
    if (hasEnglish && !confirm('Replace the current English text with a fresh translation?')) return;
    await flush(id);
    btn.innerHTML = 'Translating…';
    document.getElementById('tr-state').textContent = 'Translating — this can take up to a minute for long stories…';
    await guard(btn, async () => {
      const r = await api(`/stories/${id}/translate`, { method: 'POST' });
      $app.querySelector('[data-f=en_title]').value = r.title;
      $app.querySelector('[data-f=en_summary]').value = r.summary;
      $app.querySelector('[data-f=en_body]').value = r.body;
      document.getElementById('tr-state').textContent = 'Translated just now — please review names, numbers and quotes before publishing.';
      toast('Translation ready');
    });
  };

  if (!locked) setupUpload(id);
}

async function flush(id) {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const body = pending; pending = {};
  try {
    await api(`/stories/${id}`, { method: 'PATCH', body });
    const s = document.getElementById('save-state');
    if (s) s.textContent = 'All changes saved';
  } catch (e) {
    Object.assign(pending, body, pending);
    const s = document.getElementById('save-state');
    if (s) s.textContent = 'Not saved — ' + e.message;
  }
}
window.addEventListener('beforeunload', (e) => { if (Object.keys(pending).length) e.preventDefault(); });

function renderMedia(story, locked) {
  const el = document.getElementById('media');
  if (!story.media.length) return;
  el.innerHTML = story.media.map((m) => {
    const src = `/api/media/${m.id}/file`;
    const preview = m.kind === 'image' ? `<img src="${src}" alt="" loading="lazy">`
      : m.kind === 'video' ? `<video src="${src}" controls preload="metadata"></video>`
      : m.kind === 'audio' ? `<audio src="${src}" controls preload="none"></audio>`
      : `<a class="doc-icon" href="${src}" target="_blank" style="text-decoration:none">${esc((m.original_name.split('.').pop() || 'FILE').toUpperCase())}</a>`;
    return `<div class="media-item" data-id="${m.id}">${preview}
      <div class="media-name" title="${esc(m.original_name)}">${esc(m.original_name)}</div>
      <div class="media-meta"><span>${m.kind} · ${fmtSize(m.size)}</span>${locked ? '' : '<button class="link danger" data-del>Remove</button>'}</div>
      <input type="text" placeholder="Caption / credit" value="${esc(m.caption)}" data-cap ${locked ? 'readonly' : ''}></div>`;
  }).join('');
  el.onclick = async (e) => {
    if (!e.target.matches('[data-del]')) return;
    const item = e.target.closest('.media-item');
    if (!confirm('Remove this file?')) return;
    await guard(null, async () => { await api(`/media/${item.dataset.id}`, { method: 'DELETE' }); item.remove(); });
  };
  el.onchange = async (e) => {
    if (!e.target.matches('[data-cap]')) return;
    const item = e.target.closest('.media-item');
    await guard(null, async () => { await api(`/media/${item.dataset.id}`, { method: 'PATCH', body: { caption: e.target.value } }); toast('Caption saved'); });
  };
}

function setupUpload(id) {
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('file-input');
  zone.onclick = (e) => { if (e.target !== input) input.click(); };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); uploadFiles(id, e.dataTransfer.files); };
  input.onchange = () => uploadFiles(id, input.files);
}

function uploadFiles(id, files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const bar = document.getElementById('progress');
  const text = document.getElementById('progress-text');
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/stories/${id}/media`);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    bar.firstElementChild.style.width = pct + '%';
    text.textContent = `Uploading ${files.length} file(s)… ${pct}% of ${fmtSize(e.total)}`;
  };
  xhr.onload = async () => {
    bar.hidden = true; text.textContent = '';
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 400) return toast(data.error || 'Upload failed', true);
    toast(`${data.count} file(s) uploaded`);
    await flush(id);
    renderEditor(id);
  };
  xhr.onerror = () => { bar.hidden = true; toast('Upload failed — check your connection.', true); };
  xhr.send(form);
}

function renderWorkflow(story, sites, editor) {
  const el = document.getElementById('workflow');
  const parts = [];

  if (!editor && ['draft', 'rejected'].includes(story.status)) {
    parts.push(`<h2>Send to desk</h2><p class="hint" style="margin:0">When the script and files are ready, submit the story for an editor to review and publish.</p>
      <button class="primary" id="btn-submit">Submit for review</button>`);
  } else if (!editor && story.status === 'submitted') {
    parts.push(`<h2>Waiting for review</h2><p class="hint" style="margin:0">An editor will review and publish this story. You can still make changes.</p>`);
  }

  if (me.canPublish) {
    parts.push(`<h2>Publish to websites</h2>
      ${sites.length ? sites.map((s) => `<div class="site-target" data-site="${s.id}">
        <label class="row" style="margin:0 0 8px;color:var(--text);font-size:14px"><input type="checkbox" data-pick checked> ${esc(s.name)}
          ${s.type === 'dryrun' ? '<span class="badge draft">test mode</span>' : ''}</label>
        <div class="row">
          <select data-lang><option value="original" ${s.default_lang === 'original' ? 'selected' : ''}>Original language</option>
            <option value="en" ${s.default_lang === 'en' ? 'selected' : ''}>English</option></select>
          <select data-status><option value="publish">Publish live</option><option value="draft">Save as draft</option></select>
          <select data-media><option value="all" ${s.default_media !== 'photo' ? 'selected' : ''}>Photo + video + files</option>
            <option value="photo" ${s.default_media === 'photo' ? 'selected' : ''}>Main photo only</option></select>
        </div></div>`).join('') : '<p class="hint">No websites configured. An admin can add them under Admin.</p>'}
      <button class="primary" id="btn-publish" ${sites.length ? '' : 'disabled'}>Publish selected</button>
      <div id="publish-results" class="stack" style="margin-top:8px"></div>
      ${editor && story.status === 'submitted' ? `<hr style="border:0;border-top:1px solid var(--border);width:100%">
        <div><label>Send back to reporter with a note</label><textarea id="reject-note" rows="2" placeholder="What needs fixing?"></textarea></div>
        <button id="btn-reject">Return to reporter</button>` : ''}`);
  }

  el.innerHTML = parts.join('') || '<p class="hint">No actions available.</p>';
  el.hidden = !parts.length;

  document.getElementById('btn-submit')?.addEventListener('click', async (e) => {
    await flush(story.id);
    await guard(e.currentTarget, async () => {
      await api(`/stories/${story.id}/submit`, { method: 'POST' });
      toast('Submitted to the desk'); renderEditor(story.id);
    });
  });

  document.getElementById('btn-reject')?.addEventListener('click', async (e) => {
    await guard(e.currentTarget, async () => {
      await api(`/stories/${story.id}/reject`, { method: 'POST', body: { note: document.getElementById('reject-note').value } });
      toast('Returned to reporter'); renderEditor(story.id);
    });
  });

  document.getElementById('btn-publish')?.addEventListener('click', async (e) => {
    await flush(story.id);
    const targets = [...el.querySelectorAll('.site-target')].filter((t) => t.querySelector('[data-pick]').checked).map((t) => ({
      siteId: Number(t.dataset.site), lang: t.querySelector('[data-lang]').value, status: t.querySelector('[data-status]').value,
      media: t.querySelector('[data-media]').value,
    }));
    if (!targets.length) return toast('Choose at least one website.', true);
    if (!story.featured_frame_id && !story.featured_asset_id && !confirm('No main photo chosen. Publish without a photo from the video?')) return;
    const live = targets.filter((t) => t.status === 'publish').length;
    if (live && !confirm(`Publish this story live on ${live} website(s)?`)) return;
    const btn = e.currentTarget;
    btn.innerHTML = 'Publishing…';
    await guard(btn, async () => {
      const { results } = await api(`/stories/${story.id}/publish`, { method: 'POST', body: { targets } });
      document.getElementById('publish-results').innerHTML = results.map((r) => `<div class="result ${r.ok ? 'ok' : 'fail'}">
        <strong>${esc(r.site)}</strong> (${r.lang === 'en' ? 'English' : 'original'}): ${esc(r.message)}
        ${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">open</a>` : ''}</div>`).join('');
      const ok = results.filter((r) => r.ok).length;
      toast(`${ok} of ${results.length} published`, ok < results.length);
      setTimeout(() => renderEditor(story.id), 2500);
    });
  });
}

// ---------- admin ----------

async function renderAdmin() {
  const [users, sites, settings] = await Promise.all([api('/users'), api('/sites'), api('/settings')]);
  $app.innerHTML = `
    <div class="page-head"><h1>Admin</h1></div>
    <div class="stack">
      <section class="card stack">
        <h2>Websites &amp; CRM connections</h2>
        <p class="hint" style="margin:0"><strong>Test mode</strong> saves what would be sent into <code>data/outbox/</code> without touching the live site.
          <strong>WordPress</strong> uses the site's REST API with an Application Password (WP Admin → Users → Profile → Application Passwords).
          <strong>Custom CRM</strong> sends a multipart POST (story JSON + files) to your backend's endpoint.</p>
        <div id="sites" class="stack">${sites.map(siteForm).join('')}</div>
        <div class="row"><input type="text" id="new-site" placeholder="Add another website…" style="max-width:280px"><button id="btn-add-site">Add website</button></div>
      </section>

      <section class="card stack">
        <h2>Newsroom team</h2>
        <div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody id="users">
          ${users.map((u) => `<tr data-id="${u.id}" style="cursor:default">
            <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
            <td><select data-role style="width:auto">${['cameraman', 'journalist', 'video_editor', 'editor', 'admin'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
            <td><input type="checkbox" data-active ${u.active ? 'checked' : ''}></td>
            <td><button class="link" data-reset>Reset password</button></td></tr>`).join('')}
        </tbody></table></div>
        <form id="add-user" class="row">
          <input class="grow" name="name" placeholder="Full name" required>
          <input class="grow" name="email" type="email" placeholder="Email" required>
          <input class="grow" name="password" type="text" placeholder="Temporary password (8+)" minlength="8" required>
          <select name="role" style="width:auto"><option>cameraman</option><option selected>journalist</option><option value="video_editor">video editor</option><option>editor</option><option>admin</option></select>
          <button class="primary">Add person</button>
        </form>
      </section>

      <section class="card stack">
        <h2>Storage</h2>
        ${settings.ffmpeg ? '' : '<div class="note">ffmpeg is not installed on the server, so videos are not compressed and no screenshots are made. Run the update script to install it.</div>'}
        <div class="stat-row">
          <div><div class="stat">${fmtSize(settings.storage.free)}</div><div class="hint">free of ${fmtSize(settings.storage.total)}</div></div>
          <div><div class="stat">${settings.storage.assets}</div><div class="hint">videos &amp; photos in library</div></div>
          <div><div class="stat">${fmtSize(settings.storage.web)}</div><div class="hint">compressed web versions</div></div>
          <div><div class="stat">${fmtSize(settings.storage.originals)}</div><div class="hint">camera originals (deleted after ${settings.storage.retentionDays} days)</div></div>
        </div>
        ${settings.storage.free < settings.storage.total * 0.15 ? '<div class="note">Disk is almost full. Lower ORIGINAL_RETENTION_DAYS in the server .env, delete old library items, or move to a bigger plan.</div>' : ''}
      </section>

      <section class="card stack">
        <h2>Workflow</h2>
        <label class="row" style="color:var(--text);font-weight:500"><input type="checkbox" id="jcp" ${settings.journalistsCanPublish ? 'checked' : ''}>
          Let journalists publish directly (otherwise only editors and admins can publish)</label>
      </section>
    </div>`;

  // Sites
  const sitesEl = document.getElementById('sites');
  sitesEl.onchange = (e) => {
    if (e.target.matches('[name=type]')) {
      const f = e.target.closest('form');
      f.querySelectorAll('[data-for]').forEach((d) => (d.hidden = d.dataset.for !== e.target.value));
    }
  };
  sitesEl.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = (n) => f.elements[n]?.value ?? '';
    const body = {
      name: v('name'), base_url: v('base_url'), type: v('type'), default_lang: v('default_lang'), default_media: v('default_media'), enabled: f.elements.enabled.checked,
      config: { username: v('username'), appPassword: v('appPassword'), langParam: f.elements.langParam.checked, endpoint: v('endpoint'), token: v('token'), authHeader: v('authHeader') },
    };
    const btn = e.submitter;
    await guard(btn, async () => {
      await api(`/sites/${f.dataset.id}`, { method: 'PATCH', body });
      if (btn.value === 'test') {
        const r = await api(`/sites/${f.dataset.id}/test`, { method: 'POST' });
        f.querySelector('.test-result').innerHTML = `<div class="result ok">${esc(r.message)}</div>`;
      } else toast('Website settings saved');
    }).catch(() => {});
    if (btn.value === 'test' && !f.querySelector('.test-result .ok')) {
      f.querySelector('.test-result').innerHTML = `<div class="result fail">Connection failed — see the message above.</div>`;
    }
  };
  document.getElementById('btn-add-site').onclick = async (e) => {
    const name = document.getElementById('new-site').value.trim();
    if (!name) return;
    await guard(e.currentTarget, async () => { await api('/sites', { method: 'POST', body: { name } }); renderAdmin(); });
  };

  // Users
  const usersEl = document.getElementById('users');
  usersEl.onchange = async (e) => {
    const id = e.target.closest('tr').dataset.id;
    const body = e.target.matches('[data-role]') ? { role: e.target.value } : { active: e.target.checked };
    await guard(null, async () => { await api(`/users/${id}`, { method: 'PATCH', body }); toast('Updated'); });
  };
  usersEl.onclick = async (e) => {
    if (!e.target.matches('[data-reset]')) return;
    const pw = prompt('New password for this user (8+ characters):');
    if (!pw) return;
    await guard(null, async () => { await api(`/users/${e.target.closest('tr').dataset.id}`, { method: 'PATCH', body: { password: pw } }); toast('Password reset'); });
  };
  document.getElementById('add-user').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    await guard(e.submitter, async () => { await api('/users', { method: 'POST', body }); toast('Person added'); renderAdmin(); });
  };

  document.getElementById('jcp').onchange = async (e) => {
    await guard(null, async () => {
      await api('/settings', { method: 'PATCH', body: { journalistsCanPublish: e.target.checked } });
      me = await api('/me'); toast('Saved');
    });
  };
}

function siteForm(s) {
  const c = s.config || {};
  return `<form class="site-target stack" data-id="${s.id}">
    <div class="row"><div class="grow"><label>Website name</label><input name="name" value="${esc(s.name)}"></div>
      <div class="grow"><label>Site URL</label><input name="base_url" type="url" value="${esc(s.base_url)}" placeholder="https://"></div></div>
    <div class="row">
      <div class="grow"><label>Connection</label><select name="type">
        <option value="dryrun" ${s.type === 'dryrun' ? 'selected' : ''}>Test mode (don't send)</option>
        <option value="wordpress" ${s.type === 'wordpress' ? 'selected' : ''}>WordPress</option>
        <option value="webhook" ${s.type === 'webhook' ? 'selected' : ''}>Custom CRM / API endpoint</option></select></div>
      <div class="grow"><label>Default language</label><select name="default_lang">
        <option value="original" ${s.default_lang === 'original' ? 'selected' : ''}>Original (e.g. Kannada)</option>
        <option value="en" ${s.default_lang === 'en' ? 'selected' : ''}>English</option></select></div>
      <div class="grow"><label>Send by default</label><select name="default_media">
        <option value="all" ${s.default_media !== 'photo' ? 'selected' : ''}>Photo + video + files</option>
        <option value="photo" ${s.default_media === 'photo' ? 'selected' : ''}>Main photo only</option></select></div>
      <label class="row" style="margin:18px 0 0;color:var(--text)"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Enabled</label>
    </div>
    <div class="row" data-for="wordpress" ${s.type === 'wordpress' ? '' : 'hidden'}>
      <div class="grow"><label>WordPress username</label><input name="username" value="${esc(c.username)}" autocomplete="off"></div>
      <div class="grow"><label>Application password</label><input name="appPassword" type="password" value="${esc(c.appPassword)}" autocomplete="new-password"></div>
      <label class="row" style="margin:18px 0 0;color:var(--text)"><input type="checkbox" name="langParam" ${c.langParam ? 'checked' : ''}> Send language (Polylang/WPML)</label>
    </div>
    <div class="row" data-for="webhook" ${s.type === 'webhook' ? '' : 'hidden'}>
      <div class="grow"><label>CRM endpoint URL</label><input name="endpoint" type="url" value="${esc(c.endpoint)}" placeholder="https://crm.example.com/api/articles"></div>
      <div class="grow"><label>API token</label><input name="token" type="password" value="${esc(c.token)}" autocomplete="new-password"></div>
      <div class="grow"><label>Auth header (optional)</label><input name="authHeader" value="${esc(c.authHeader)}" placeholder="default: Authorization: Bearer"></div>
    </div>
    <div class="row"><button class="primary" value="save">Save</button><button value="test">Save &amp; test connection</button></div>
    <div class="test-result"></div>
  </form>`;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot().catch(() => renderLogin());
