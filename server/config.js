import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function normalizeBasePath(v) {
  const p = String(v || '').trim().replace(/\/+$/, '');
  if (!p || p === '/') return '';
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  if (!/^(\/[\w.~-]+)+$/.test(withSlash) || withSlash.split('/').some((seg) => /^\.+$/.test(seg))) {
    throw new Error(`Invalid BASE_PATH "${v}" – use something like /dockerpanel`);
  }
  return withSlash;
}

export const config = {
  root,
  // Sub-path the panel is served under behind a reverse proxy, e.g. /dockerpanel ('' = domain root).
  basePath: normalizeBasePath(process.env.BASE_PATH),
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  // Force the Secure cookie flag. Auto-enabled when the request arrives over HTTPS (incl. X-Forwarded-Proto).
  cookieSecure: bool(process.env.COOKIE_SECURE),
  // Trust X-Forwarded-* headers (set when running behind nginx / traefik).
  trustProxy: bool(process.env.TRUST_PROXY),
  // Read-only mode: hides/blocks every mutating action and the terminal.
  readOnly: bool(process.env.READ_ONLY),
  // Allow opening a shell inside containers.
  allowExec: bool(process.env.ALLOW_EXEC, true),
  // Allow the file browser to write / delete. Setting false keeps it read-only.
  allowFileWrite: bool(process.env.ALLOW_FILE_WRITE, true),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  hostLabel: process.env.HOST_LABEL || '',
  // Extra origins allowed for API/WebSocket calls, comma separated (e.g. https://ops.example.com).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProd: process.env.NODE_ENV === 'production',
};

if (!config.adminPassword) {
  config.adminPassword = crypto.randomBytes(9).toString('base64url');
  config.generatedPassword = true;
}
