import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer } from 'ws';
import { audit } from './audit.js';
import { clientIp, getSession, originAllowed } from './auth.js';
import { config } from './config.js';
import { calcStats, containerName, dockerError } from './docker.js';
import { hosts, withTimeout } from './hosts.js';
import { stripBase } from './paths.js';

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

const AUTO_SHELL = [
  '/bin/sh',
  '-c',
  'if command -v bash >/dev/null 2>&1; then exec bash; elif command -v ash >/dev/null 2>&1; then exec ash; else exec sh; fi',
];

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function fail(ws, err) {
  sendJson(ws, { type: 'error', message: dockerError(err).message });
  ws.close(1011);
}

// Keep connections alive through proxies and reap dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

/* ------------------------------------------------------------------ logs */

async function handleLogs(ws, id, q, ctx) {
  const container = ctx.docker.getContainer(id);
  const info = await withTimeout(container.inspect());
  const tailParam = q.get('tail') || '500';
  const opts = {
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: q.get('timestamps') === '1',
    tail: tailParam === 'all' ? 'all' : Math.max(0, Number(tailParam) || 500),
  };
  const since = Number(q.get('since'));
  if (since > 0) opts.since = Math.floor(Date.now() / 1000) - since;

  const stream = await container.logs(opts);
  if (ws.readyState !== ws.OPEN) return stream.destroy?.();

  // Batch output so a noisy container doesn't produce thousands of frames per second.
  let pending = [];
  let pendingBytes = 0;
  let timer = null;
  const flush = () => {
    timer = null;
    if (!pending.length) return;
    sendJson(ws, { type: 'log', chunks: pending });
    pending = [];
    pendingBytes = 0;
  };
  const push = (kind, text) => {
    if (!text) return;
    const last = pending[pending.length - 1];
    if (last && last[0] === kind) last[1] += text;
    else pending.push([kind, text]);
    pendingBytes += text.length;
    if (pendingBytes > 256 * 1024) flush();
    else if (!timer) timer = setTimeout(flush, 60);
  };

  const makeSink = (kind) => {
    const decoder = new StringDecoder('utf8');
    const sink = new PassThrough();
    sink.on('data', (d) => push(kind, decoder.write(d)));
    sink.on('end', () => push(kind, decoder.end()));
    return sink;
  };

  const out = makeSink('o');
  const errSink = makeSink('e');
  if (info.Config?.Tty) stream.pipe(out);
  else container.modem.demuxStream(stream, out, errSink);

  sendJson(ws, { type: 'meta', tty: !!info.Config?.Tty, running: !!info.State?.Running });

  stream.on('end', () => {
    flush();
    sendJson(ws, { type: 'end' });
  });
  stream.on('error', (e) => fail(ws, e));
  ws.on('close', () => {
    clearTimeout(timer);
    stream.destroy?.();
  });
}

/* ------------------------------------------------------------------ exec */

async function handleExec(ws, id, q, ctx) {
  if (config.readOnly || !config.allowExec) throw Object.assign(new Error('终端功能已被禁用'), { statusCode: 403 });

  const container = ctx.docker.getContainer(id);
  const info = await withTimeout(container.inspect());
  if (!info.State?.Running) throw Object.assign(new Error('容器未运行，无法进入终端'), { statusCode: 409 });

  const shell = (q.get('shell') || 'auto').trim();
  const user = (q.get('user') || '').trim();
  const cols = Math.min(500, Math.max(10, Number(q.get('cols')) || 120));
  const rows = Math.min(200, Math.max(5, Number(q.get('rows')) || 30));
  const cmd = shell === 'auto' ? AUTO_SHELL : shell.split(/\s+/).filter(Boolean);

  const exec = await withTimeout(container.exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: user || undefined,
    Env: ['TERM=xterm-256color', `COLUMNS=${cols}`, `LINES=${rows}`],
  }));
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  if (ws.readyState !== ws.OPEN) return stream.end();

  audit({
    user: ctx.user,
    ip: ctx.ip,
    action: 'exec',
    host: ctx.hostId,
    hostName: hosts.name(ctx.hostId),
    target: info.Id,
    targetName: containerName(info),
    ok: true,
    detail: `${shell}${user ? ` as ${user}` : ''}`,
  });

  const resize = (w, h) => exec.resize({ w, h }).catch(() => {});
  resize(cols, rows);

  // Hold keystrokes until the shell has printed something (its prompt). Shells like busybox ash reset the tty when
  // they initialise line editing and drop input typed before that – e.g. a user typing right after connecting.
  let shellReady = false;
  const pendingInput = [];
  const writeInput = (d) => (shellReady ? stream.write(d) : pendingInput.push(d));
  const markReady = () => {
    if (shellReady) return;
    shellReady = true;
    for (const d of pendingInput.splice(0)) stream.write(d);
  };
  const readyFallback = setTimeout(markReady, 1500);
  stream.on('data', (d) => {
    if (!shellReady) setTimeout(markReady, 60);
    if (ws.readyState === ws.OPEN) ws.send(d, { binary: true });
  });
  stream.on('close', () => clearTimeout(readyFallback));
  stream.on('end', () => {
    exec
      .inspect()
      .then((r) => sendJson(ws, { type: 'exit', code: r.ExitCode }))
      .catch(() => sendJson(ws, { type: 'exit', code: null }))
      .finally(() => ws.close(1000));
  });
  stream.on('error', (e) => fail(ws, e));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return writeInput(raw);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') writeInput(msg.data);
    else if (msg.type === 'resize') resize(Math.max(10, msg.cols | 0), Math.max(5, msg.rows | 0));
  });
  ws.on('close', () => stream.end());

  sendJson(ws, { type: 'ready' });
}

/* ----------------------------------------------------------------- stats */

async function handleStats(ws, id, _q, ctx) {
  const container = ctx.docker.getContainer(id);
  const stream = await container.stats({ stream: true });
  if (ws.readyState !== ws.OPEN) return stream.destroy?.();
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const raw = JSON.parse(line);
        if (!raw.read || raw.read.startsWith('0001-')) continue; // stopped container: empty samples
        sendJson(ws, { type: 'stats', data: calcStats(raw) });
      } catch {
        /* partial line */
      }
    }
  });
  stream.on('end', () => sendJson(ws, { type: 'end' }));
  stream.on('error', (e) => fail(ws, e));
  ws.on('close', () => stream.destroy?.());
}

/* --------------------------------------------------------------- routing */

const routes = [
  [/^\/ws\/hosts\/([\w-]+)\/containers\/([\w.-]+)\/logs$/, handleLogs],
  [/^\/ws\/hosts\/([\w-]+)\/containers\/([\w.-]+)\/exec$/, handleExec],
  [/^\/ws\/hosts\/([\w-]+)\/containers\/([\w.-]+)\/stats$/, handleStats],
];

function reject(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWebSockets(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(stripBase(req.url), 'http://localhost');
    const route = routes.find(([re]) => re.test(url.pathname));
    if (!route) return reject(socket, 404, 'Not Found');
    if (!originAllowed(req)) return reject(socket, 403, 'Forbidden');
    const session = getSession(req);
    if (!session) return reject(socket, 401, 'Unauthorized');

    const [re, handler] = route;
    const [, hostId, id] = url.pathname.match(re);
    let docker;
    try {
      docker = hosts.docker(hostId);
    } catch {
      return reject(socket, 404, 'Not Found');
    }
    const ctx = { user: session.user, ip: clientIp(req), hostId, docker };

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.on('error', () => {});
      handler(ws, id, url.searchParams, ctx).catch(async (err) => fail(ws, await hosts.explain(hostId, err)));
    });
  });
}
