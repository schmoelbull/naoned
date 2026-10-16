import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'naoned_session';
const MAX_AGE_S = 7 * 86_400;
const attempts = new Map(); // ip -> { count, until }

const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

export function isAuthenticated(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

export function login(req, res) {
  const ip = req.ip;
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes.' });

  const pwd = String(req.body?.password || '');
  const ok = config.adminPassword
    && pwd.length === config.adminPassword.length
    && crypto.timingSafeEqual(Buffer.from(pwd), Buffer.from(config.adminPassword));
  if (!ok) {
    const count = (a?.count || 0) + 1;
    attempts.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  attempts.delete(ip);
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${config.cookieSecure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}
