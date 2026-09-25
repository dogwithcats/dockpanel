import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'dp_session';
// Scope the cookie to the sub-path so apps on other paths of the same domain never see it.
const COOKIE_PATH = config.basePath || '/';
const sessions = new Map(); // token -> { user, exp, ip }
const failures = new Map(); // ip -> { count, until }

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

function isHttps(req) {
  if (req.socket?.encrypted) return true;
  return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { ...s, token };
}

/**
 * Reject cross-site requests. Browsers always send Origin on WebSocket upgrades and on
 * non-GET fetches, so comparing it with Host blocks CSRF and cross-site WebSocket hijacking.
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) – still need a valid session cookie
  if (config.allowedOrigins.includes(origin)) return true;
  const hosts = [req.headers.host];
  if (config.trustProxy && req.headers['x-forwarded-host']) {
    hosts.push(String(req.headers['x-forwarded-host']).split(',')[0].trim());
  }
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (hosts.includes(originHost)) return true;
  warnOnce(
    `${origin}|${hosts.join(',')}`,
    `[auth] rejected request: Origin ${origin} does not match Host ${hosts.join(' / ')}. ` +
      'Behind a reverse proxy set `proxy_set_header Host $http_host;` (or add the origin to ALLOWED_ORIGINS).',
  );
  return false;
}

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key) || warned.size > 100) return;
  warned.add(key);
  console.warn(msg);
}

export function login(req, res) {
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    const secs = Math.ceil((f.until - Date.now()) / 1000);
    return res.status(429).json({ error: `尝试次数过多，请 ${secs} 秒后再试` });
  }
  const { username, password } = req.body || {};
  const ok = safeEqual(username || '', config.adminUser) & safeEqual(password || '', config.adminPassword);
  if (!ok) {
    const now = Date.now();
    // Count failures inside a sliding window; an expired lock or an old window starts over.
    const fresh = !f || (f.until ? f.until <= now : now - f.first > LOCK_MS);
    const count = fresh ? 1 : f.count + 1;
    failures.set(ip, { count, first: fresh ? now : f.first, until: count >= MAX_FAILURES ? now + LOCK_MS : 0 });
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = config.sessionTtlHours * 3600;
  sessions.set(token, { user: config.adminUser, exp: Date.now() + maxAge * 1000, ip });
  const secure = config.cookieSecure || isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
  return { user: config.adminUser };
}

export function logout(req, res) {
  const s = getSession(req);
  if (s) sessions.delete(s.token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function requireAuth(req, res, next) {
  if (!originAllowed(req)) return res.status(403).json({ error: '跨站请求被拒绝' });
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = s.user;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
  for (const [k, f] of failures) if (f.until ? f.until < now : now - f.first > LOCK_MS) failures.delete(k);
}, 60_000).unref();
