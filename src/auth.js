import crypto from 'node:crypto';

const SESSION_DAYS = 14;
export const COOKIE = 'nd_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 864e5 };
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionMiddleware(db) {
  const lookup = db.prepare(`
    SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = readCookie(req, COOKIE);
    req.sessionToken = token;
    req.user = token ? lookup.get(token, new Date().toISOString()) || null : null;
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this action.' });
  next();
};
