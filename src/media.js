// Media library processing: web-friendly video, screenshots, and disk housekeeping.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, ASSET_DIR, PARTIAL_DIR } from './db.js';

const FRAME_COUNT = 10;
const RETENTION_DAYS = Number(process.env.ORIGINAL_RETENTION_DAYS || 7);
export const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;

// Longest side at most 1280px (720p for phone video in either orientation), even dimensions for H.264.
const SCALE = 'scale=1280:1280:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2';

export const assetPath = (file) => path.join(ASSET_DIR, file);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    // Low priority on Linux/Mac so video work doesn't slow the app; Windows has no `nice`.
    const [bin, argv] = process.platform === 'win32' ? [cmd, args] : ['nice', ['-n', '10', cmd, ...args]];
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.trim().split('\n').pop()}`))));
  });
}

/** Voiceovers come as webm/ogg/opus from phones; editing software wants AAC (.m4a). Returns false without ffmpeg. */
export async function convertToM4a(input, output) {
  if (!ffmpegAvailable) return false;
  await run('ffmpeg', ['-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output]);
  return true;
}

async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number.parseFloat(out) || 0;
}

export async function grabFrame(assetId, videoFile, t, custom = false) {
  const file = `${path.parse(videoFile).name.replace(/-web$/, '')}-f${Math.round(t * 1000)}.jpg`;
  await run('ffmpeg', ['-y', '-ss', t.toFixed(3), '-i', assetPath(videoFile), '-frames:v', '1', '-q:v', '3', '-vf', SCALE, assetPath(file)]);
  const r = db.prepare('INSERT INTO frames (asset_id, file, t, custom) VALUES (?,?,?,?)').run(assetId, file, t, custom ? 1 : 0);
  return Number(r.lastInsertRowid);
}

async function processAsset(id) {
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!a || a.status !== 'processing') return;
  const base = path.parse(a.original_file).name;
  try {
    if (!ffmpegAvailable) {
      db.prepare(`UPDATE assets SET status = 'ready', web_file = original_file, web_size = size, error = 'ffmpeg not installed: no compression or screenshots' WHERE id = ?`).run(id);
      return;
    }
    if (a.kind === 'image') {
      const web = `${base}-web.jpg`;
      await run('ffmpeg', ['-y', '-i', assetPath(a.original_file), '-vf', SCALE, '-q:v', '3', assetPath(web)]);
      db.prepare(`UPDATE assets SET status = 'ready', web_file = ?, web_size = ? WHERE id = ?`)
        .run(web, fs.statSync(assetPath(web)).size, id);
      return;
    }
    const web = `${base}-web.mp4`;
    await run('ffmpeg', ['-y', '-i', assetPath(a.original_file), '-vf', SCALE, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', assetPath(web)]);
    const duration = await probeDuration(assetPath(web));
    const n = duration >= FRAME_COUNT ? FRAME_COUNT : Math.max(1, Math.ceil(duration));
    for (let i = 0; i < n; i++) await grabFrame(id, web, (duration * (i + 0.5)) / n);
    db.prepare(`UPDATE assets SET status = 'ready', web_file = ?, web_size = ?, duration = ? WHERE id = ?`)
      .run(web, fs.statSync(assetPath(web)).size, duration, id);
  } catch (e) {
    console.error(`Processing asset ${id} failed:`, e.message);
    db.prepare(`UPDATE assets SET status = 'failed', error = ? WHERE id = ?`).run(e.message.slice(0, 500), id);
  }
}

// One job at a time so a burst of uploads doesn't overload a small server.
let queue = Promise.resolve();
export function enqueue(id) {
  queue = queue.then(() => processAsset(id));
  return queue;
}

/** Remove camera originals once a web version exists and the retention period has passed. */
export function cleanupOriginals(days = RETENTION_DAYS) {
  // Originals tagged to a story still waiting for the video editor are kept (up to 30 days).
  const old = db.prepare(`SELECT id, original_file FROM assets a WHERE status = 'ready' AND original_file IS NOT NULL
    AND web_file IS NOT NULL AND web_file != original_file AND created_at < datetime('now', ?)
    AND (created_at < datetime('now', '-30 days') OR NOT EXISTS (
      SELECT 1 FROM story_assets sa JOIN video_tasks vt ON vt.story_id = sa.story_id
      WHERE sa.asset_id = a.id AND vt.status != 'done'))`).all(`-${days} days`);
  for (const a of old) {
    fs.rmSync(assetPath(a.original_file), { force: true });
    db.prepare('UPDATE assets SET original_file = NULL WHERE id = ?').run(a.id);
  }
  // Abandoned resumable uploads
  for (const u of db.prepare(`SELECT id FROM uploads WHERE created_at < datetime('now', '-3 days')`).all()) {
    fs.rmSync(path.join(PARTIAL_DIR, u.id), { force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  }
  return old.length;
}

export function startMediaWorker() {
  for (const a of db.prepare(`SELECT id FROM assets WHERE status = 'processing' ORDER BY id`).all()) enqueue(a.id);
  cleanupOriginals();
  setInterval(cleanupOriginals, 3600e3).unref();
}

export function diskUsage() {
  const s = fs.statfsSync(ASSET_DIR);
  const sum = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN original_file IS NOT NULL THEN size ELSE 0 END), 0) AS originals,
    COALESCE(SUM(CASE WHEN web_file != original_file THEN web_size ELSE 0 END), 0) AS web FROM assets`).get();
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize, assets: sum.n, originals: sum.originals, web: sum.web, retentionDays: RETENTION_DAYS };
}
