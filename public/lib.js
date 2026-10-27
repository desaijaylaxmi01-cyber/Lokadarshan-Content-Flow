// Shared browser helpers.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { onUnauthorized(); throw new Error(data.error || 'Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), isError ? 6000 : 3000);
}

export const fmtSize = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB';
export const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
export const badge = (status) => `<span class="badge ${status}">${status}</span>`;
export const CATEGORIES = ['Belagavi', 'Karnataka', 'India', 'Politics', 'Crime', 'Agriculture', 'Education', 'Health', 'Business', 'Sports', 'Entertainment', 'Weather', 'Civic issues'];

export async function guard(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; }
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) { btn.disabled = false; btn.innerHTML = label; } }
}

export const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function modal(html) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}
