import { config } from './config.js';

/**
 * Map an incoming request URL onto the app's internal routes (/api, /ws, assets, SPA).
 *
 * Works with every common nginx style:
 *   location /dockerpanel/ { proxy_pass http://up; }    -> /dockerpanel/api/x  (prefix kept)
 *   location /dockerpanel/ { proxy_pass http://up/; }   -> /api/x              (prefix stripped)
 *   location /dockerpanel  { proxy_pass http://up/; }   -> //api/x             (double slash)
 */
export function stripBase(url) {
  let u = url.replace(/^\/{2,}/, '/');
  const base = config.basePath;
  if (base && (u === base || u.startsWith(`${base}/`) || u.startsWith(`${base}?`))) {
    u = u.slice(base.length) || '/';
    if (u.startsWith('?')) u = `/${u}`;
    u = u.replace(/^\/{2,}/, '/');
  }
  return u;
}
