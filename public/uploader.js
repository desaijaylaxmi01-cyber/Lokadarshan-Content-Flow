// Resumable uploads for phones on patchy mobile data.
// Files go up in 8 MB chunks; after a network drop the upload resumes from the last chunk the
// server confirmed. If the page is closed, choosing the same file again continues where it stopped.
import { api } from './lib.js';

const CHUNK = 8 * 1024 * 1024;
const STORE = 'nd-uploads';

const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
function remembered() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function remember(key, id) {
  try {
    const all = remembered();
    if (id) all[key] = id; else delete all[key];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* private mode: resume-after-reload just won't work */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitOnline() {
  return navigator.onLine ? Promise.resolve() : new Promise((r) => window.addEventListener('online', r, { once: true }));
}

export class UploadQueue {
  constructor(onChange) {
    this.items = [];
    this.onChange = onChange;
    this.running = false;
    this.wakeLock = null;
  }

  get busy() { return this.items.some((i) => ['waiting', 'uploading', 'retrying'].includes(i.status)); }

  add(files, meta) {
    for (const file of files) {
      this.items.push({ file, ...meta, key: fileKey(file), status: 'waiting', sent: 0, error: '' });
    }
    this.onChange();
    this.run();
  }

  retry(item) {
    item.status = 'waiting';
    item.error = '';
    this.onChange();
    this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    await this.keepAwake(true);
    try {
      let item;
      while ((item = this.items.find((i) => i.status === 'waiting'))) await this.upload(item);
    } finally {
      this.running = false;
      await this.keepAwake(false);
    }
  }

  // Ask the phone not to sleep while uploading (supported on Android Chrome and iOS 16.4+).
  async keepAwake(on) {
    try {
      if (on && !this.wakeLock && 'wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
      if (!on && this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; }
    } catch { /* not supported or denied */ }
  }

  async upload(item) {
    const { file } = item;
    item.status = 'uploading';
    this.onChange();
    let failures = 0;
    for (;;) {
      try {
        const id = await this.session(item);
        while (item.sent < file.size) {
          const res = await fetch(`/api/uploads/${id}`, {
            method: 'PUT',
            headers: { 'Upload-Offset': String(item.sent), 'Content-Type': 'application/octet-stream' },
            body: file.slice(item.sent, item.sent + CHUNK),
          });
          const data = await res.json().catch(() => ({}));
          if (res.status === 409) { item.sent = data.received; continue; }
          if (res.status === 404) { remember(item.key, null); item.uploadId = null; item.sent = 0; throw new Error('restart'); }
          if (!res.ok) { const e = new Error(data.error || `Upload failed (${res.status})`); e.fatal = res.status < 500; throw e; }
          item.sent = data.received;
          item.status = 'uploading';
          failures = 0;
          this.onChange();
        }
        const done = await api(`/uploads/${id}/complete`, { method: 'POST', body: { note: item.note, location: item.location } });
        remember(item.key, null);
        item.assetId = done.id;
        item.status = 'done';
        this.onChange();
        return;
      } catch (e) {
        if (e.fatal) { item.status = 'error'; item.error = e.message; this.onChange(); return; }
        if (e.message === 'restart') continue;
        // Network problem: wait and try again, forever, backing off up to 30 s.
        failures++;
        item.status = 'retrying';
        item.error = navigator.onLine ? 'Weak signal — retrying…' : 'No internet — will continue when back online…';
        this.onChange();
        await waitOnline();
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
        item.status = 'uploading';
      }
    }
  }

  /** Reuse the server-side upload if this file was started before, else create one. */
  async session(item) {
    if (!item.uploadId) {
      const previous = remembered()[item.key];
      if (previous) {
        try {
          const s = await api(`/uploads/${previous}`);
          item.uploadId = previous;
          item.sent = s.received;
          return previous;
        } catch { remember(item.key, null); }
      }
      try {
        const s = await api('/uploads', { method: 'POST', body: { name: item.file.name, size: item.file.size, mime: item.file.type || guessType(item.file.name) } });
        item.uploadId = s.id;
        item.sent = 0;
        remember(item.key, s.id);
      } catch (e) {
        // A rejected file (wrong type, too big) is not worth retrying.
        if (navigator.onLine && !/fetch|network/i.test(e.message)) e.fatal = true;
        throw e;
      }
    }
    return item.uploadId;
  }
}

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', '3gp': 'video/3gpp', mkv: 'video/x-matroska', webm: 'video/webm',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp' }[ext] || '';
}
