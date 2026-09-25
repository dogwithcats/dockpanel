import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { audit, listAudit } from './audit.js';
import { clientIp, getSession, login, logout, originAllowed, requireAuth } from './auth.js';
import { config } from './config.js';
import { containerName, dockerError, PROTECTED_LABEL, summarize } from './docker.js';
import { fileErrorHandler, filesRouter } from './files-routes.js';
import { hosts, withTimeout } from './hosts.js';
import { stripBase } from './paths.js';
import { attachWebSockets } from './ws.js';

hosts.init();

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

// Serve the app both with and without the BASE_PATH prefix (see paths.js).
app.use((req, _res, next) => {
  req.url = stripBase(req.url);
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (config.isProd) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  }
  next();
});
app.use(express.json({ limit: '256kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ auth */

app.post('/api/auth/login', (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ error: '跨站请求被拒绝' });
  const result = login(req, res);
  if (result && !res.headersSent) {
    audit({ user: result.user, ip: clientIp(req), action: 'login', ok: true });
    res.json(result);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const s = getSession(req);
  logout(req, res);
  if (s) audit({ user: s.user, ip: clientIp(req), action: 'logout', ok: true });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '未登录' });
  res.json({
    user: s.user,
    readOnly: config.readOnly,
    allowExec: config.allowExec && !config.readOnly,
    allowFileWrite: config.allowFileWrite && !config.readOnly,
  });
});

app.use('/api', requireAuth);

function blockMutations(_req, res, next) {
  if (config.readOnly) return res.status(403).json({ error: '当前为只读模式' });
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ----------------------------------------------------------------- hosts */

app.get('/api/hosts', wrap(async (req, res) => {
  res.json(await hosts.list({ probe: req.query.probe !== '0' }));
}));

app.post('/api/hosts/test', blockMutations, wrap(async (req, res) => {
  res.json(await hosts.test(req.body || {}, req.body?.id));
}));

app.post('/api/hosts', blockMutations, wrap(async (req, res) => {
  const h = hosts.add(req.body || {});
  audit({ user: req.user, ip: clientIp(req), action: 'host-add', host: h.id, hostName: h.name, ok: true, detail: h.address });
  await hosts.probe(h.id);
  res.json(hosts.publicHost(h.id));
}));

app.put('/api/hosts/order', blockMutations, wrap(async (req, res) => {
  hosts.reorder(req.body?.ids || []);
  res.json({ ok: true });
}));

app.put('/api/hosts/:host', blockMutations, wrap(async (req, res) => {
  const h = hosts.update(req.params.host, req.body || {});
  audit({ user: req.user, ip: clientIp(req), action: 'host-update', host: h.id, hostName: h.name, ok: true, detail: h.address });
  await hosts.probe(h.id);
  res.json(hosts.publicHost(h.id));
}));

app.delete('/api/hosts/:host', blockMutations, wrap(async (req, res) => {
  const name = hosts.name(req.params.host);
  hosts.remove(req.params.host);
  audit({ user: req.user, ip: clientIp(req), action: 'host-remove', host: req.params.host, hostName: name, ok: true });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ containers */

/** Containers across all hosts (or ?host=id). Unreachable hosts are reported, not fatal. */
app.get('/api/containers', wrap(async (req, res) => {
  const ids = req.query.host ? [String(req.query.host)] : hosts.ids();
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const list = await withTimeout(hosts.docker(id).listContainers({ all: true }), 8000, '获取容器列表');
        return { id, items: list.map((c) => summarize(c, id)) };
      } catch (err) {
        const e = await hosts.explain(id, err);
        return { id, items: [], error: dockerError(e).message };
      }
    }),
  );
  res.json({
    items: results.flatMap((r) => r.items),
    errors: results.filter((r) => r.error).map((r) => ({ host: r.id, name: hosts.name(r.id), error: r.error })),
  });
}));

const hostRouter = express.Router({ mergeParams: true });
app.use('/api/hosts/:host', (req, res, next) => {
  try {
    req.hostId = req.params.host;
    req.docker = hosts.docker(req.hostId);
    next();
  } catch (e) {
    next(e);
  }
}, hostRouter);

hostRouter.use('/containers/:id/files', filesRouter, fileErrorHandler);

hostRouter.get('/containers/:id', wrap(async (req, res) => {
  res.json(await withTimeout(req.docker.getContainer(req.params.id).inspect()));
}));

const ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);
const DESTRUCTIVE = new Set(['stop', 'restart', 'pause', 'kill', 'remove']);

async function guard(docker, id, action) {
  const info = await withTimeout(docker.getContainer(id).inspect());
  if (DESTRUCTIVE.has(action) && info.Config?.Labels?.[PROTECTED_LABEL] === 'true') {
    throw Object.assign(new Error(`容器 ${containerName(info)} 受保护（${PROTECTED_LABEL}=true），不允许 ${action}`), {
      statusCode: 403,
      info,
    });
  }
  return info;
}

function auditContainer(req, action, info, id, ok, detail) {
  audit({
    user: req.user,
    ip: clientIp(req),
    action,
    host: req.hostId,
    hostName: hosts.name(req.hostId),
    target: info?.Id || id,
    targetName: info ? containerName(info) : undefined,
    ok,
    detail,
  });
}

hostRouter.post('/containers/:id/:action', blockMutations, async (req, res, next) => {
  const { id, action } = req.params;
  if (!ACTIONS.has(action)) return res.status(400).json({ error: `不支持的操作: ${action}` });
  let info;
  try {
    info = await guard(req.docker, id, action);
    const opts = action === 'stop' || action === 'restart' ? { t: Number(req.body?.timeout ?? 10) } : {};
    await req.docker.getContainer(id)[action](opts);
    auditContainer(req, action, info, id, true);
    res.json({ ok: true });
  } catch (e) {
    // 304 = already started / already stopped – treat as success
    if (e?.statusCode === 304) return res.json({ ok: true, notModified: true });
    info ??= e?.info;
    const err = await hosts.explain(req.hostId, e);
    auditContainer(req, action, info, id, false, dockerError(err).message);
    next(err);
  }
});

hostRouter.delete('/containers/:id', blockMutations, async (req, res, next) => {
  const { id } = req.params;
  const force = req.query.force === '1';
  const volumes = req.query.volumes === '1';
  let info;
  try {
    info = await guard(req.docker, id, 'remove');
    await req.docker.getContainer(id).remove({ force, v: volumes });
    auditContainer(req, 'remove', info, id, true, [force && 'force', volumes && 'volumes'].filter(Boolean).join(',') || undefined);
    res.json({ ok: true });
  } catch (e) {
    info ??= e?.info;
    const err = await hosts.explain(req.hostId, e);
    auditContainer(req, 'remove', info, id, false, dockerError(err).message);
    next(err);
  }
});

/** Split a multiplexed (non-TTY) log buffer into plain text. */
function demuxBuffer(buf) {
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts);
}

hostRouter.get('/containers/:id/logs/download', wrap(async (req, res) => {
  const c = req.docker.getContainer(req.params.id);
  const info = await withTimeout(c.inspect());
  const tail = req.query.tail === 'all' || !req.query.tail ? 'all' : Math.max(1, Number(req.query.tail) || 1000);
  const buf = await withTimeout(
    c.logs({ follow: false, stdout: true, stderr: true, timestamps: req.query.timestamps === '1', tail }),
    60_000,
    '下载日志',
  );
  const body = info.Config?.Tty ? buf : demuxBuffer(buf);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${hosts.name(req.hostId)}-${containerName(info)}-${stamp}.log`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="log.txt"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.send(body);
}));

/* ----------------------------------------------------------------- audit */

app.get('/api/audit', (req, res) => {
  res.json(listAudit(Math.min(2000, Number(req.query.limit) || 500)));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not Found' }));

/* ------------------------------------------------------------ static SPA */

const dist = path.join(config.root, 'dist');
const indexFile = path.join(dist, 'index.html');

/**
 * Read index.html through a small cache that revalidates on modification time.
 * Without this, a rebuild (new asset hashes) would keep serving the old file until the process restarts,
 * leaving the browser asking for assets that no longer exist.
 */
let cachedIndex = { mtimeMs: 0, html: '' };
function indexHtml() {
  const baseHref = `${config.basePath}/`;
  const stat = fs.statSync(indexFile);
  if (stat.mtimeMs !== cachedIndex.mtimeMs) {
    cachedIndex = {
      mtimeMs: stat.mtimeMs,
      html: fs
        .readFileSync(indexFile, 'utf8')
        .replace('<head>', `<head>\n    <base href="${baseHref}" />`)
        // Absolute asset URLs too, so deep links work even if <base> were ignored.
        .replace(/(src|href)="\.\/(?!\/)/g, `$1="${baseHref}`),
    };
  }
  return cachedIndex.html;
}

// Fail fast and loudly when the frontend has not been built yet
if (!fs.existsSync(indexFile)) {
  console.error(`\n  ✗ ${indexFile} 不存在 – 先执行 npm run build，或使用已构建好的镜像\n`);
}

if (fs.existsSync(indexFile)) {
  app.use(express.static(dist, { index: false, maxAge: '7d', immutable: true }));
  // Missing static files must 404 instead of falling through to index.html (avoids confusing MIME errors).
  app.get(/\.(?:js|mjs|css|map|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|json|txt)$/i, (_req, res) => res.status(404).end());
  app.get('/{*splat}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml());
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const { status, message } = dockerError(err);
  if (status >= 500 && status !== 502 && status !== 504) console.error('[error]', err);
  res.status(status).json({ error: message });
});

/* ---------------------------------------------------------------- server */

const server = http.createServer(app);
attachWebSockets(server);

server.listen(config.port, config.host, async () => {
  console.log(
    `\n  DockPanel  →  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.basePath}/`,
  );
  if (config.basePath) console.log(`  base path: ${config.basePath}`);
  console.log(`  user: ${config.adminUser}`);
  if (config.generatedPassword) {
    console.log(`  password (generated, set ADMIN_PASSWORD to fix it): ${config.adminPassword}`);
  }
  if (config.readOnly) console.log('  mode: READ-ONLY');
  const list = await hosts.list();
  if (!list.length) console.log('  hosts: none yet – add one in the web UI');
  for (const h of list) {
    const s = h.status;
    console.log(
      `  host ${h.name.padEnd(14)} ${h.address.padEnd(36)} ${s.state === 'online' ? `✓ docker ${s.info.serverVersion} (${s.latency}ms)` : `✗ ${s.error}`}`,
    );
  }
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
