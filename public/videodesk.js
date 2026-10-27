// Reporter voiceover recorder, and the video editor's desk (queue + download package).
import { esc, api, toast, fmtSize, fmtDate, fmtDuration, guard, copyText } from './lib.js';

// ---------- Voiceover (story editor) ----------

const recorderType = () => ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));

/** Voiceover card in the story editor. `story.voiceovers` from GET /stories/:id. */
export function renderVoiceover(el, story, locked, onChange) {
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.isSecureContext);
  el.innerHTML = `
    <div class="panel-head" style="margin:0"><h2 style="margin:0">🎙️ Voiceover <span class="hint" style="font-weight:400">for Instagram &amp; YouTube</span></h2></div>
    <p class="hint" style="margin:0">Read the script aloud in a quiet place, holding the phone about a hand's length away.
      ${!locked && !canRecord ? 'Recording here needs a secure (https) connection. Record with your phone\'s voice recorder app, then tap <strong>Upload audio</strong>.' : ''}</p>
    ${locked ? '' : `<div class="row">
      ${canRecord ? '<button class="primary" data-rec>● Record</button>' : ''}
      <label class="btn" style="margin:0">⬆ Upload audio<input type="file" accept="audio/*" hidden data-file></label>
      <span class="rec-state hint" data-state></span></div>`}
    <div class="stack" data-list>${story.voiceovers.length ? story.voiceovers.map((m, i) => `
      <div class="voice-item" data-id="${m.id}">
        <strong>Take ${i + 1}</strong>
        <audio controls preload="none" src="/api/media/${m.id}/file"></audio>
        <span class="hint">${fmtSize(m.size)} · ${fmtDate(m.created_at)}</span>
        ${locked ? '' : '<button class="link danger" data-del>Remove</button>'}
      </div>`).join('') : '<div class="hint">No voiceover yet.</div>'}</div>`;

  const state = el.querySelector('[data-state]');
  const send = async (blob, name) => {
    const form = new FormData();
    form.append('file', blob, name);
    state.textContent = 'Saving voiceover…';
    const res = await fetch(`/api/stories/${story.id}/voiceover`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { state.textContent = ''; return toast(data.error || 'Could not save the voiceover', true); }
    toast('Voiceover saved');
    onChange();
  };

  el.querySelector('[data-file]')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) send(f, f.name);
  });

  let rec = null, timer = null;
  el.querySelector('[data-rec]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = recorderType();
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer);
        btn.textContent = '● Record';
        btn.classList.remove('recording');
        const mime = rec.mimeType || 'audio/webm';
        rec = null;
        send(new Blob(chunks, { type: mime }), `voiceover.${mime.includes('mp4') ? 'm4a' : 'webm'}`);
      };
      rec.start(1000);
      const started = Date.now();
      btn.textContent = '■ Stop';
      btn.classList.add('recording');
      timer = setInterval(() => { state.textContent = `Recording ${fmtDuration((Date.now() - started) / 1000)}`; }, 250);
    } catch (err) {
      toast(err.name === 'NotAllowedError' ? 'Please allow the microphone for this site.' : 'Microphone not available: ' + err.message, true);
    }
  });

  el.querySelector('[data-list]').onclick = async (e) => {
    if (!e.target.matches('[data-del]')) return;
    if (!confirm('Remove this voiceover take?')) return;
    const id = e.target.closest('.voice-item').dataset.id;
    await guard(null, async () => { await api(`/media/${id}`, { method: 'DELETE' }); onChange(); });
  };
}

// ---------- Send to video desk (story editor) ----------

const PLATFORM = { instagram: '📱 Instagram Reel', youtube: '▶️ YouTube video' };
const STATUS = { todo: 'To do', editing: 'Editing', done: 'Done' };

export function renderVideoTasks(el, story, onChange) {
  const tasks = story.video_tasks;
  const missing = ['instagram', 'youtube'].filter((p) => !tasks.some((t) => t.platform === p));
  el.innerHTML = `
    <h2 style="margin:0">Video desk</h2>
    ${tasks.map((t) => `<div class="task-row">
      <span>${PLATFORM[t.platform]}</span> <span class="badge task-${t.status}">${STATUS[t.status]}</span>
      ${t.editor_name ? `<span class="hint">${esc(t.editor_name)}</span>` : ''}
      ${t.final_url ? `<a href="${esc(t.final_url)}" target="_blank" rel="noopener">open</a>` : ''}
      ${t.status === 'todo' ? `<button class="link danger" data-cancel="${t.id}">Cancel</button>` : ''}
    </div>`).join('')}
    ${missing.length ? `
      <p class="hint" style="margin:0">${tasks.length ? 'Also send for:' : 'When the script, voiceover and video are ready, send them to the video editor.'}</p>
      ${missing.map((p) => `<label class="row" style="margin:0;color:var(--text);font-weight:500"><input type="checkbox" data-platform="${p}" checked> ${PLATFORM[p]}</label>`).join('')}
      <button class="primary" data-send>Send to video desk</button>` : ''}`;

  el.querySelector('[data-send]')?.addEventListener('click', async (e) => {
    const platforms = [...el.querySelectorAll('[data-platform]:checked')].map((c) => c.dataset.platform);
    if (!platforms.length) return toast('Choose Instagram and/or YouTube.', true);
    if (!story.voiceovers.length && !confirm('No voiceover recorded yet. Send to the video desk anyway?')) return;
    if (!story.assets.some((a) => a.kind === 'video') && !confirm('No video is tagged. Send anyway?')) return;
    await guard(e.currentTarget, async () => {
      await api(`/stories/${story.id}/video-tasks`, { method: 'POST', body: { platforms } });
      toast('Sent to the video desk'); onChange();
    });
  });
  el.onclick = async (e) => {
    const id = e.target.dataset.cancel;
    if (!id || !confirm('Cancel this video job?')) return;
    await guard(null, async () => { await api(`/video-tasks/${id}`, { method: 'DELETE' }); onChange(); });
  };
}

// ---------- Video desk: queue ----------

const deskState = { show: 'open' };
const thumb = (s) => s.featured_frame_id ? `/api/frames/${s.featured_frame_id}/file` : s.featured_asset_id ? `/api/assets/${s.featured_asset_id}/web` : '';
const taskChips = (tasks) => tasks.map((t) => `<span class="badge task-${t.status}">${t.platform === 'instagram' ? 'Instagram' : 'YouTube'}: ${STATUS[t.status]}</span>`).join(' ');

export async function renderDesk($app) {
  $app.innerHTML = `
    <div class="page-head"><h1>Video desk</h1></div>
    <div class="tabs" data-tabs>
      ${[['open', 'To edit'], ['done', 'Finished'], ['all', 'All']].map(([v, l]) => `<button data-show="${v}" class="${deskState.show === v ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div class="asset-grid desk-grid" data-grid><div class="hint">Loading…</div></div>`;
  $app.querySelector('[data-tabs]').onclick = (e) => { if (e.target.dataset.show) { deskState.show = e.target.dataset.show; renderDesk($app); } };
  const rows = await api('/video-desk');
  const grid = $app.querySelector('[data-grid]');
  if (!grid) return;
  const shown = rows.filter((r) => {
    const done = r.tasks.every((t) => t.status === 'done');
    return deskState.show === 'all' || (deskState.show === 'done' ? done : !done);
  });
  grid.innerHTML = shown.length ? shown.map((s) => `
    <a class="asset-card" href="#/video/${s.id}" style="text-decoration:none;color:inherit">
      <div class="asset-thumb">${thumb(s) ? `<img src="${thumb(s)}" alt="" loading="lazy">` : '<div class="thumb-placeholder">No photo</div>'}</div>
      <div class="asset-info">
        <div class="asset-note">${esc(s.title || s.en_title || '(untitled)')}</div>
        <div class="hint">${s.location ? '📍 ' + esc(s.location) + ' · ' : ''}${esc(s.author_name)} · sent ${fmtDate(s.sent_at)}</div>
        <div class="hint">${s.video_count} video · ${s.voiceover_count ? `🎙️ ${s.voiceover_count} voiceover` : '⚠️ no voiceover'}</div>
        <div class="row" style="gap:6px">${taskChips(s.tasks)}</div>
      </div></a>`).join('')
    : `<div class="hint">${deskState.show === 'open' ? 'Nothing waiting. New stories appear here when reporters send them.' : 'Nothing here.'}</div>`;
}

// ---------- Video desk: one story's package ----------

function copyBlock(label, text, rows = 4) {
  return `<div class="copy-block"><div class="panel-head" style="margin:0 0 4px"><label style="margin:0">${label}</label>
    <button class="link" data-copy style="color:var(--info)">📋 Copy</button></div>
    <textarea readonly rows="${rows}">${esc(text)}</textarea></div>`;
}

export async function renderPackage($app, id) {
  const s = await api(`/video-desk/${id}`);
  const videos = s.assets.filter((a) => a.kind === 'video');
  const photos = s.assets.filter((a) => a.kind === 'image');
  const mainFrame = s.featured_frame_id;
  const fileUrl = (m) => `/api/video-desk/${s.id}/media/${m.id}`;

  $app.innerHTML = `
    <div class="page-head">
      <div><a href="#/video-desk" class="hint" style="text-decoration:none">← Video desk</a>
        <h1>${esc(s.title || s.en_title)}</h1>
        <div class="hint">${s.location ? '📍 ' + esc(s.location) + ' · ' : ''}Reporter: ${esc(s.author_name)}</div></div>
      <a class="btn primary big-download" href="/api/video-desk/${s.id}/package.zip" download>⬇ Download everything (.zip)</a>
    </div>
    <div class="editor-layout">
      <div class="stack">
        <section class="card stack">
          <h2 style="margin:0">Video${videos.length > 1 ? 's' : ''} from camera</h2>
          ${videos.length ? videos.map((a, i) => `<div class="linked">
            <div class="row" style="justify-content:space-between"><strong>Video ${i + 1}: ${esc(a.note || a.original_name)}</strong>
              <a class="btn" href="/api/assets/${a.id}/original" download>⬇ ${a.original_file ? 'Original' : 'Web version'} (${fmtSize(a.original_file ? a.size : a.web_size)})</a></div>
            ${a.status === 'ready' ? `<video src="/api/assets/${a.id}/web" controls playsinline preload="metadata" class="player"></video>` : `<div class="note">${a.status === 'failed' ? 'Processing failed' : 'Processing…'}</div>`}
            <div class="hint">${esc(a.uploader_name)} · ${fmtDate(a.created_at)}${a.duration ? ' · ' + fmtDuration(a.duration) : ''}</div>
          </div>`).join('') : '<div class="hint">No video tagged on this story.</div>'}
          ${photos.length ? `<h3 style="margin:8px 0 0">Photos</h3><div class="frame-strip">${photos.map((a) => `<a href="/api/assets/${a.id}/original" download><img src="/api/assets/${a.id}/web" alt=""></a>`).join('')}</div>` : ''}
          ${mainFrame ? `<h3 style="margin:8px 0 0">Main photo / thumbnail</h3>
            <a href="/api/frames/${mainFrame}/file" download="main-photo.jpg"><img src="/api/frames/${mainFrame}/file" alt="" class="main-photo"></a>` : ''}
        </section>
        <section class="card stack">
          <h2 style="margin:0">🎙️ Voiceover</h2>
          ${s.voiceovers.length ? s.voiceovers.map((m, i) => `<div class="voice-item"><strong>Take ${i + 1}</strong>
            <audio controls preload="none" src="${fileUrl(m)}"></audio>
            <a class="btn" href="${fileUrl(m)}" download="voiceover-${i + 1}${m.stored_name.slice(m.stored_name.lastIndexOf('.'))}">⬇</a></div>`).join('')
            : '<div class="note">The reporter has not recorded a voiceover yet.</div>'}
        </section>
        <section class="card stack">
          <h2 style="margin:0">Script</h2>
          ${copyBlock('Script (original)', [s.title, s.summary, s.body].filter(Boolean).join('\n\n'), 8)}
          ${s.en_body ? copyBlock('Script (English)', [s.en_title, s.en_summary, s.en_body].filter(Boolean).join('\n\n'), 6) : ''}
        </section>
      </div>
      <aside class="sidebar stack">
        <section class="card stack">
          <h2 style="margin:0">📱 Instagram</h2>
          ${copyBlock('Caption + hashtags', [s.ig_caption, s.hashtags].filter(Boolean).join('\n\n'), 4)}
          ${copyBlock('Keywords', s.keywords, 2)}
        </section>
        <section class="card stack">
          <h2 style="margin:0">▶️ YouTube</h2>
          ${copyBlock('Title', s.yt_title || s.en_title || s.title, 2)}
          ${copyBlock('Description', [s.yt_description || s.summary, s.hashtags].filter(Boolean).join('\n\n'), 4)}
          ${copyBlock('Tags', s.keywords, 2)}
        </section>
        ${s.video_tasks.map((t) => taskCard(t, s)).join('')}
      </aside>
    </div>`;

  $app.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copyText(b.closest('.copy-block').querySelector('textarea').value, 'Copied');
  });
  $app.querySelectorAll('.task-card').forEach((card) => bindTask(card, s, () => renderPackage($app, id)));
}

function taskCard(t, s) {
  const finals = s.finals.filter((m) => m.purpose === `final_${t.platform}`);
  return `<section class="card stack task-card" data-task="${t.id}" data-platform="${t.platform}">
    <div class="panel-head" style="margin:0"><h2 style="margin:0">${PLATFORM[t.platform]}</h2><span class="badge task-${t.status}">${STATUS[t.status]}</span></div>
    ${t.editor_name ? `<div class="hint">Editor: ${esc(t.editor_name)} · updated ${fmtDate(t.updated_at)}</div>` : ''}
    ${t.status === 'todo' ? '<button class="primary" data-status="editing">Start editing</button>' : ''}
    ${t.status !== 'todo' ? `
      <div><label>Link after posting</label><input type="url" data-url value="${esc(t.final_url)}" placeholder="${t.platform === 'youtube' ? 'https://youtu.be/…' : 'https://www.instagram.com/reel/…'}"></div>
      <div class="row">${t.status === 'editing' ? '<button class="primary" data-status="done">✓ Mark done</button>' : '<button data-status="done">Save link</button><button class="link" data-status="editing">Reopen</button>'}</div>
      <div><label>Finished video (optional)</label>
        ${finals.map((m) => `<div class="hint"><a href="/api/video-desk/${s.id}/media/${m.id}" download>${esc(m.original_name)}</a> (${fmtSize(m.size)})</div>`).join('')}
        <input type="file" accept="video/*" data-final>
        <div class="progress" hidden><div></div></div></div>` : ''}
    ${t.platform === 'youtube' ? '<p class="hint" style="margin:0">When marked done with the YouTube link, the website posts embed this video instead of uploading the raw clip.</p>' : ''}
  </section>`;
}

function bindTask(card, s, refresh) {
  const id = card.dataset.task;
  card.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = () => guard(b, async () => {
      const body = { status: b.dataset.status };
      const url = card.querySelector('[data-url]');
      if (url) body.final_url = url.value;
      if (body.status === 'done' && !body.final_url && !confirm('Mark done without the link to the posted video?')) return;
      await api(`/video-tasks/${id}`, { method: 'PATCH', body });
      toast(body.status === 'done' ? 'Marked done' : 'Updated'); refresh();
    });
  });
  const input = card.querySelector('[data-final]');
  if (!input) return;
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    const bar = card.querySelector('.progress');
    bar.hidden = false;
    const form = new FormData();
    form.append('file', f);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/video-desk/${s.id}/final/${card.dataset.platform}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`; };
    xhr.onload = () => {
      if (xhr.status >= 400) { bar.hidden = true; return toast(JSON.parse(xhr.responseText || '{}').error || 'Upload failed', true); }
      toast('Finished video uploaded'); refresh();
    };
    xhr.onerror = () => { bar.hidden = true; toast('Upload failed — check your connection.', true); };
    xhr.send(form);
  };
}
