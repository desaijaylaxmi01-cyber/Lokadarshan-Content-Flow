// Cameraman upload page, media library, and the video/screenshot picker used in the story editor.
import { esc, api, toast, fmtSize, fmtDate, fmtDuration, guard, modal } from './lib.js';
import { UploadQueue } from './uploader.js';

const thumbUrl = (a) => a.kind === 'image' ? `/api/assets/${a.id}/web` : a.thumb_frame_id ? `/api/frames/${a.thumb_frame_id}/file` : '';

function assetCard(a, { action = '' } = {}) {
  const thumb = a.status === 'ready' && thumbUrl(a)
    ? `<img src="${thumbUrl(a)}" alt="" loading="lazy">`
    : `<div class="thumb-placeholder">${a.status === 'failed' ? '⚠️ Failed' : 'Processing…'}</div>`;
  return `<div class="asset-card" data-id="${a.id}">
    <div class="asset-thumb">${thumb}
      <span class="asset-kind">${a.kind === 'video' ? `▶ ${a.duration ? fmtDuration(a.duration) : 'Video'}` : 'Photo'}</span>
      ${a.story_count ? `<span class="asset-used">Used ×${a.story_count}</span>` : ''}</div>
    <div class="asset-info">
      <div class="asset-note">${esc(a.note || a.original_name)}</div>
      <div class="hint">${a.location ? '📍 ' + esc(a.location) + ' · ' : ''}${esc(a.uploader_name)} · ${fmtDate(a.created_at)}</div>
      ${action}
    </div></div>`;
}

// ---------- Cameraman: upload ----------

let queue = null;
window.addEventListener('beforeunload', (e) => { if (queue?.busy) e.preventDefault(); });

export function renderUpload($app) {
  queue ??= new UploadQueue(() => drawQueue());
  let lastPlace = '';
  try { lastPlace = localStorage.getItem('nd-place') || ''; } catch {}

  $app.innerHTML = `
    <div class="upload-page stack">
      <h1>Send to newsroom</h1>
      <section class="card stack">
        <div><label for="up-note">What is this news? <span class="hint">(one line, Kannada or English)</span></label>
          <textarea id="up-note" rows="2" placeholder="ಉದಾ: ಗೋಕಾಕ ಜಲಪಾತಕ್ಕೆ ಪ್ರವಾಸಿಗರ ದಂಡು"></textarea></div>
        <div><label for="up-place">Place</label><input type="text" id="up-place" value="${esc(lastPlace)}" placeholder="e.g. Belagavi, Gokak, Chikkodi"></div>
        <div class="capture-buttons">
          <label class="capture-btn primary-capture">🎥<span>Record video</span><input type="file" accept="video/*" capture="environment" hidden></label>
          <label class="capture-btn">📷<span>Take photo</span><input type="file" accept="image/*" capture="environment" hidden></label>
          <label class="capture-btn">🖼️<span>From gallery</span><input type="file" accept="video/*,image/*" multiple hidden></label>
        </div>
        <p class="hint" style="margin:0">Keep this screen open while uploading. If the signal drops, the upload waits and continues by itself.</p>
      </section>
      <section id="queue" class="stack"></section>
      <section class="card stack">
        <div class="panel-head" style="margin:0"><h2 style="margin:0">My recent uploads</h2><button class="link" id="refresh-mine">Refresh</button></div>
        <div id="mine" class="asset-grid"><div class="hint">Loading…</div></div>
      </section>
    </div>`;

  for (const input of $app.querySelectorAll('.capture-btn input')) {
    input.onchange = () => {
      if (!input.files.length) return;
      const note = document.getElementById('up-note').value.trim();
      const location = document.getElementById('up-place').value.trim();
      try { localStorage.setItem('nd-place', location); } catch {}
      queue.add([...input.files], { note, location });
      input.value = '';
    };
  }
  document.getElementById('refresh-mine').onclick = loadMine;
  drawQueue();
  loadMine();
}

function drawQueue() {
  const el = document.getElementById('queue');
  if (!el || !queue) return;
  const items = queue.items.filter((i) => i.status !== 'done' || Date.now() - (i.doneAt ??= Date.now()) < 60000);
  el.innerHTML = items.map((i, n) => {
    const pct = Math.floor((i.sent / i.file.size) * 100);
    const label = { waiting: 'Waiting…', uploading: `Uploading ${pct}% of ${fmtSize(i.file.size)}`, retrying: esc(i.error),
      done: '✅ Sent to newsroom', error: '❌ ' + esc(i.error) }[i.status];
    return `<div class="card upload-item ${i.status}">
      <div class="row" style="justify-content:space-between"><strong class="media-name">${esc(i.file.name)}</strong>
        ${i.status === 'error' ? `<button data-retry="${n}">Retry</button>` : ''}</div>
      <div class="progress"><div style="width:${i.status === 'done' ? 100 : pct}%"></div></div>
      <div class="hint">${label}</div></div>`;
  }).join('');
  el.onclick = (e) => {
    const n = e.target.dataset.retry;
    if (n !== undefined) queue.retry(items[n]);
  };
  if (queue.items.some((i) => i.status === 'done' && !i.listed)) {
    queue.items.forEach((i) => { if (i.status === 'done') i.listed = true; });
    loadMine();
  }
}

async function loadMine() {
  const el = document.getElementById('mine');
  if (!el) return;
  const list = await api('/assets?mine=1');
  el.innerHTML = list.length ? list.slice(0, 30).map((a) => assetCard(a)).join('') : '<div class="hint">Nothing uploaded yet.</div>';
  el.onclick = (e) => { const c = e.target.closest('.asset-card'); if (c) openAsset(Number(c.dataset.id), { onChange: loadMine }); };
  if (list.some((a) => a.status === 'processing')) setTimeout(() => document.body.contains(el) && loadMine(), 5000);
}

// ---------- Library ----------

const libState = { q: '', days: '2', kind: '' };

export function renderLibrary($app, me) {
  $app.innerHTML = `
    <div class="page-head"><h1>Media library</h1>
      <a class="btn" href="#/upload">⬆ Upload</a></div>
    ${libraryFilters()}
    <div id="lib" class="asset-grid"><div class="hint">Loading…</div></div>`;
  bindFilters($app, () => loadLibrary(document.getElementById('lib'), (id) => openAsset(id, { me, onChange: () => renderLibrary($app, me) })));
}

function libraryFilters() {
  return `<div class="row lib-filters">
    <input type="text" data-lf="q" placeholder="Search note, place, cameraman…" value="${esc(libState.q)}" class="grow">
    <select data-lf="days" style="width:auto">
      ${[['1', 'Today'], ['2', 'Last 2 days'], ['7', 'Last 7 days'], ['', 'All']].map(([v, l]) => `<option value="${v}" ${libState.days === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <select data-lf="kind" style="width:auto">
      ${[['', 'Videos & photos'], ['video', 'Videos'], ['image', 'Photos']].map(([v, l]) => `<option value="${v}" ${libState.kind === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></div>`;
}

function bindFilters(root, reload) {
  for (const el of root.querySelectorAll('[data-lf]')) {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      libState[el.dataset.lf] = el.value;
      clearTimeout(bindFilters.t);
      bindFilters.t = setTimeout(reload, 250);
    });
  }
  reload();
}

async function loadLibrary(el, onOpen, linked = new Set()) {
  const qs = new URLSearchParams({ q: libState.q, days: libState.days, kind: libState.kind, all: '1' });
  const list = await api('/assets?' + qs);
  if (!document.body.contains(el)) return;
  el.innerHTML = list.length
    ? list.map((a) => assetCard(a, { action: linked.has(a.id) ? '<span class="badge published">Tagged</span>' : '' })).join('')
    : `<div class="hint">Nothing found${libState.days ? ' — try “All”' : ''}.</div>`;
  el.onclick = (e) => { const c = e.target.closest('.asset-card'); if (c) onOpen(Number(c.dataset.id)); };
  if (list.some((a) => a.status === 'processing')) setTimeout(() => loadLibrary(el, onOpen, linked), 5000);
}

async function openAsset(id, { me, onChange } = {}) {
  const a = await api(`/assets/${id}`);
  const writer = me && me.user.role !== 'cameraman';
  const d = modal(`<div class="stack">
    <div class="panel-head" style="margin:0"><h2 style="margin:0">${a.kind === 'video' ? 'Video' : 'Photo'}</h2><button class="link" data-close>✕ Close</button></div>
    ${a.status !== 'ready' ? `<div class="note">${a.status === 'failed' ? 'Processing failed: ' + esc(a.error) : 'Still processing — screenshots appear in a minute.'}</div>` : ''}
    ${a.status === 'ready' ? (a.kind === 'video' ? `<video src="/api/assets/${a.id}/web" controls playsinline class="player"></video>` : `<img src="/api/assets/${a.id}/web" class="player" alt="">`) : ''}
    ${a.frames.length ? `<div class="frame-strip">${a.frames.map((f) => `<img src="/api/frames/${f.id}/file" alt="" loading="lazy">`).join('')}</div>` : ''}
    <div><label>Note</label><textarea data-note rows="2">${esc(a.note)}</textarea></div>
    <div><label>Place</label><input type="text" data-place value="${esc(a.location)}"></div>
    <div class="hint">${esc(a.uploader_name)} · ${fmtDate(a.created_at)} · ${esc(a.original_name)} (${fmtSize(a.size)})</div>
    <div class="row">
      <button data-save>Save note</button>
      <a class="btn" href="/api/assets/${a.id}/original" download>⬇ Download${a.original_file ? ' original' : ''}</a>
      ${writer ? '<button class="primary" data-story>Start a story with this</button>' : ''}
      <button class="link danger" data-delete>Delete</button>
    </div></div>`);
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-save]').onclick = (e) => guard(e.currentTarget, async () => {
    await api(`/assets/${id}`, { method: 'PATCH', body: { note: d.querySelector('[data-note]').value, location: d.querySelector('[data-place]').value } });
    toast('Saved'); onChange?.();
  });
  d.querySelector('[data-delete]').onclick = (e) => {
    if (!confirm('Delete this file from the library?')) return;
    guard(e.currentTarget, async () => { await api(`/assets/${id}`, { method: 'DELETE' }); d.close(); toast('Deleted'); onChange?.(); });
  };
  d.querySelector('[data-story]')?.addEventListener('click', (e) => guard(e.currentTarget, async () => {
    const { id: storyId } = await api('/stories', { method: 'POST', body: {} });
    await api(`/stories/${storyId}`, { method: 'PATCH', body: { location: a.location } });
    await api(`/stories/${storyId}/assets`, { method: 'POST', body: { assetId: id } });
    d.close();
    location.hash = `#/story/${storyId}`;
  }));
}

// ---------- Story editor: tagged videos and the main photo ----------

/** Library picker; resolves when the reporter taps a video/photo (or closes). */
export function pickFromLibrary(linkedIds) {
  return new Promise((resolve) => {
    const d = modal(`<div class="stack">
      <div class="panel-head" style="margin:0"><h2 style="margin:0">Tag a video or photo</h2><button class="link" data-close>✕ Close</button></div>
      ${libraryFilters()}
      <div class="asset-grid" data-grid><div class="hint">Loading…</div></div></div>`);
    d.classList.add('wide');
    d.querySelector('[data-close]').onclick = () => d.close();
    d.addEventListener('close', () => resolve(null));
    const grid = d.querySelector('[data-grid]');
    bindFilters(d, () => loadLibrary(grid, (id) => { resolve(id); d.close(); }, new Set(linkedIds)));
  });
}

/**
 * Renders the "Video & photo" section of a story. `story` must include assets (with frames) and
 * featured_frame_id / featured_asset_id. Calls onChange() after anything is saved.
 */
export function renderLinked(el, story, locked, onChange) {
  const picked = (kind, id) => (kind === 'frame' ? story.featured_frame_id === id : story.featured_asset_id === id);
  const processing = story.assets.some((a) => a.status === 'processing');

  el.innerHTML = `
    <div class="panel-head"><h2 style="margin:0">Video &amp; main photo</h2>
      ${locked ? '' : '<button class="primary" data-tag>+ Tag video / photo</button>'}</div>
    ${story.assets.length ? '' : `<p class="hint" style="margin:0">Tag the cameraman's video for this news from the media library, then tap the screenshot to use as the main photo.</p>`}
    ${story.assets.map((a) => `<div class="linked" data-asset="${a.id}">
      <div class="row" style="justify-content:space-between">
        <div><strong>${esc(a.note || a.original_name)}</strong>
          <div class="hint">${a.location ? '📍 ' + esc(a.location) + ' · ' : ''}${esc(a.uploader_name)} · ${fmtDate(a.created_at)}</div></div>
        <div class="row">
          <a class="btn" href="/api/assets/${a.id}/original" download title="Download for Instagram">⬇</a>
          ${locked ? '' : `<button class="link danger" data-untag="${a.id}">Remove</button>`}</div>
      </div>
      ${a.status === 'processing' ? '<div class="note">Processing video — screenshots will appear shortly…</div>' : ''}
      ${a.status === 'failed' ? `<div class="note">Processing failed: ${esc(a.error)}</div>` : ''}
      ${a.status === 'ready' && a.kind === 'video' ? `
        <video src="/api/assets/${a.id}/web" controls playsinline preload="metadata" class="player"></video>
        ${locked ? '' : `<button data-grab="${a.id}">📸 Use this moment as main photo</button>`}
        <div class="hint">Or tap a screenshot:</div>
        <div class="frame-strip pick">${a.frames.map((f) => `<button class="frame ${picked('frame', f.id) ? 'chosen' : ''}" data-frame="${f.id}" ${locked ? 'disabled' : ''}>
          <img src="/api/frames/${f.id}/file" alt="Screenshot at ${fmtDuration(f.t)}" loading="lazy"><span>${f.custom ? '📸 ' : ''}${fmtDuration(f.t)}</span></button>`).join('')}</div>` : ''}
      ${a.status === 'ready' && a.kind === 'image' ? `
        <div class="frame-strip pick"><button class="frame ${picked('asset', a.id) ? 'chosen' : ''}" data-photo="${a.id}" ${locked ? 'disabled' : ''}>
          <img src="/api/assets/${a.id}/web" alt=""><span>Use as main photo</span></button></div>` : ''}
    </div>`).join('')}`;

  el.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if ('tag' in t.dataset) {
      const assetId = await pickFromLibrary(story.assets.map((a) => a.id));
      if (assetId) await guard(null, async () => { await api(`/stories/${story.id}/assets`, { method: 'POST', body: { assetId } }); onChange(); });
    } else if (t.dataset.untag) {
      if (!confirm('Remove this video/photo from the story? (It stays in the library.)')) return;
      await guard(t, async () => { await api(`/stories/${story.id}/assets/${t.dataset.untag}`, { method: 'DELETE' }); onChange(); });
    } else if (t.dataset.frame) {
      await guard(null, async () => { await api(`/stories/${story.id}`, { method: 'PATCH', body: { featured_frame_id: Number(t.dataset.frame) } }); onChange(); });
    } else if (t.dataset.photo) {
      await guard(null, async () => { await api(`/stories/${story.id}`, { method: 'PATCH', body: { featured_asset_id: Number(t.dataset.photo) } }); onChange(); });
    } else if (t.dataset.grab) {
      const video = t.closest('.linked').querySelector('video');
      video.pause();
      await guard(t, async () => {
        const f = await api(`/assets/${t.dataset.grab}/frames`, { method: 'POST', body: { t: video.currentTime } });
        await api(`/stories/${story.id}`, { method: 'PATCH', body: { featured_frame_id: f.id } });
        toast('Main photo set'); onChange();
      });
    }
  };
  if (processing) setTimeout(() => document.body.contains(el) && onChange(), 5000);
}
