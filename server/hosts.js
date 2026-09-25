import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import { config } from './config.js';
import { dockerError } from './docker.js';
import { SshDockerAgent } from './ssh-agent.js';

/**
 * Host registry. Persisted in <DATA_DIR>/hosts.json (mode 0600 – it may contain SSH keys / passwords).
 *
 * Host config:
 *   { id, name, type: 'local' | 'ssh' | 'tcp',
 *     socketPath?,                                        // local
 *     host?, port?, username?, privateKey?, passphrase?, password?, hostKey?,   // ssh
 *     tls?, ca?, cert?, key?,                             // tcp
 *     createdAt }
 */

const FILE = path.join(config.dataDir, 'hosts.json');
const SECRET_FIELDS = ['privateKey', 'passphrase', 'password', 'ca', 'cert', 'key'];
const CALL_TIMEOUT = 8_000;

export class HostError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Reject after `ms` – for non-streaming Docker calls so one dead server can't stall the whole UI. */
export function withTimeout(promise, ms = CALL_TIMEOUT, what = 'Docker 请求') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new HostError(`${what}超时（${ms / 1000}s）`, 504)), ms);
    }),
  ]);
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : v;
}

/** Validate + normalize user input into a stored config. `prev` supplies kept secrets on update. */
export function normalizeHost(input, prev) {
  const type = input.type;
  if (!['local', 'ssh', 'tcp'].includes(type)) throw new HostError('连接方式无效');
  const name = clean(input.name);
  if (!name) throw new HostError('请填写服务器名称');
  if (name.length > 64) throw new HostError('名称过长');

  const out = { id: prev?.id, name, type, createdAt: prev?.createdAt || new Date().toISOString() };
  const keep = (field) => {
    const v = input[field];
    if (v === undefined || v === null || v === '') return prev?.type === type ? prev?.[field] : undefined;
    return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() + (field === 'password' || field === 'passphrase' ? '' : '\n') : v;
  };

  if (type === 'local') {
    out.socketPath = clean(input.socketPath) || '/var/run/docker.sock';
    if (!out.socketPath.startsWith('/')) throw new HostError('Socket 路径必须是绝对路径');
    return out;
  }

  out.host = clean(input.host);
  if (!out.host || !/^[\w.:-]+$/.test(out.host)) throw new HostError('请填写正确的主机地址（IP 或域名）');
  const port = Number(input.port || (type === 'ssh' ? 22 : input.tls === false ? 2375 : 2376));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostError(`端口无效：${input.port}（应为 1-65535）`);
  out.port = port;

  if (type === 'ssh') {
    out.username = clean(input.username) || 'root';
    if (!/^[\w.-]+$/.test(out.username)) throw new HostError('用户名无效');
    out.privateKey = keep('privateKey');
    out.passphrase = keep('passphrase');
    out.password = keep('password');
    if (input.authMethod === 'password') {
      out.privateKey = undefined;
      out.passphrase = undefined;
    } else if (input.authMethod === 'key') {
      out.password = undefined;
    }
    if (!out.privateKey && !out.password) throw new HostError('请提供 SSH 私钥或密码');
    if (out.privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(out.privateKey)) {
      throw new HostError('私钥格式不正确（应以 -----BEGIN … PRIVATE KEY----- 开头）');
    }
    // Keep the trusted fingerprint unless the address changed or the user asked to reset it
    const sameTarget = prev && prev.type === 'ssh' && prev.host === out.host && prev.port === out.port;
    out.hostKey = input.resetHostKey || !sameTarget ? undefined : prev.hostKey;
    return out;
  }

  // tcp
  out.tls = input.tls !== false;
  if (out.tls) {
    out.ca = keep('ca');
    out.cert = keep('cert');
    out.key = keep('key');
    if (!out.ca || !out.cert || !out.key) throw new HostError('TLS 连接需要 CA 证书、客户端证书和客户端私钥');
  }
  return out;
}

/** What the API returns – never includes secrets. */
function publicView(h) {
  const v = { id: h.id, name: h.name, type: h.type, createdAt: h.createdAt };
  if (h.type === 'local') v.socketPath = h.socketPath;
  else {
    v.host = h.host;
    v.port = h.port;
  }
  if (h.type === 'ssh') {
    v.username = h.username;
    v.authMethod = h.privateKey ? 'key' : 'password';
    v.hasPrivateKey = !!h.privateKey;
    v.hasPassphrase = !!h.passphrase;
    v.hasPassword = !!h.password;
    v.hostKey = h.hostKey || null;
  }
  if (h.type === 'tcp') {
    v.tls = h.tls;
    v.hasCerts = !!(h.ca && h.cert && h.key);
  }
  return v;
}

export function describeAddress(h) {
  if (h.type === 'local') return `unix://${h.socketPath}`;
  if (h.type === 'ssh') return `ssh://${h.username}@${h.host}:${h.port}`;
  return `${h.tls ? 'tcp+tls' : 'tcp'}://${h.host}:${h.port}`;
}

class HostManager {
  constructor() {
    /** @type {Map<string, { cfg: object, docker: Docker, agent?: SshDockerAgent, status: object }>} */
    this.entries = new Map();
    this.order = [];
  }

  init() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    let list;
    if (fs.existsSync(FILE)) {
      list = JSON.parse(fs.readFileSync(FILE, 'utf8')).hosts || [];
    } else {
      list = this.#bootstrap();
      this.#write(list);
    }
    for (const h of list) this.#mount(h);
    this.#warnEnvDrift();
    setInterval(() => {
      for (const e of this.entries.values()) e.agent?.reapIdle();
    }, 60_000).unref();
  }

  /** Socket configured through the environment (DOCKER_SOCKET or DOCKER_HOST=unix://…), if any. */
  static envSocket() {
    if (process.env.DOCKER_SOCKET) return process.env.DOCKER_SOCKET;
    const dh = process.env.DOCKER_HOST || '';
    return dh.startsWith('unix://') ? dh.slice('unix://'.length) : null;
  }

  /** First run: register the local daemon so single-server setups need no configuration. */
  #bootstrap() {
    const explicit = HostManager.envSocket();
    const socketPath = explicit || '/var/run/docker.sock';
    // An explicitly configured socket is always registered – if it's wrong the UI shows why.
    // The default path is only registered when it exists (panel may manage remote servers only).
    if (!explicit && !fs.existsSync(socketPath)) return [];
    return [{ id: 'local', name: config.hostLabel || '本机', type: 'local', socketPath, createdAt: new Date().toISOString() }];
  }

  /** hosts.json wins after the first start – tell the operator when the environment disagrees. */
  #warnEnvDrift() {
    const explicit = HostManager.envSocket();
    if (!explicit) return;
    const locals = [...this.entries.values()].filter((e) => e.cfg.type === 'local');
    if (locals.some((e) => e.cfg.socketPath === explicit)) return;
    console.warn(
      `  ⚠ DOCKER_SOCKET/DOCKER_HOST=${explicit} is ignored because ${FILE} already exists` +
        (locals.length ? ` (local server uses ${locals.map((e) => e.cfg.socketPath).join(', ')})` : '') +
        '.\n    Change the socket path in 服务器管理 → 编辑, or delete hosts.json to re-initialise.',
    );
  }

  #write(list) {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ hosts: list }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }

  #persist() {
    this.#write(this.order.map((id) => this.entries.get(id).cfg));
  }

  #createClient(cfg) {
    if (cfg.type === 'local') return { docker: new Docker({ socketPath: cfg.socketPath }) };
    if (cfg.type === 'tcp') {
      return {
        docker: new Docker({
          protocol: cfg.tls ? 'https' : 'http',
          host: cfg.host,
          port: cfg.port,
          ca: cfg.ca,
          cert: cfg.cert,
          key: cfg.key,
        }),
      };
    }
    const agent = new SshDockerAgent({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      password: cfg.password,
      hostKey: cfg.hostKey,
      onHostKey: (fp) => {
        // Trust on first use: remember the fingerprint the first time we connect successfully
        const e = this.entries.get(cfg.id);
        if (e && e.cfg === cfg && !cfg.hostKey) {
          cfg.hostKey = fp;
          agent.opts.hostKey = fp;
          this.#persist();
        }
      },
    });
    // protocol http + custom agent: every request becomes a `docker system dial-stdio` channel
    return { docker: new Docker({ protocol: 'http', host: 'docker', port: 80, agent }), agent };
  }

  #mount(cfg) {
    const { docker, agent } = this.#createClient(cfg);
    this.entries.set(cfg.id, { cfg, docker, agent, status: { state: 'unknown' } });
    if (!this.order.includes(cfg.id)) this.order.push(cfg.id);
  }

  #unmount(id) {
    const e = this.entries.get(id);
    e?.agent?.destroy();
    this.entries.delete(id);
  }

  get(id) {
    const e = this.entries.get(id);
    if (!e) throw new HostError(`服务器 ${id} 不存在`, 404);
    return e;
  }

  docker(id) {
    return this.get(id).docker;
  }

  ids() {
    return [...this.order];
  }

  name(id) {
    return this.entries.get(id)?.cfg.name || id;
  }

  /** Make "socket hang up" style SSH errors explain the real reason. */
  async explain(id, err) {
    const e = this.entries.get(id);
    if (!e?.agent) return err;
    const msg = err?.message || '';
    if (/socket hang up|ECONNRESET|EPIPE/i.test(msg) || !err?.statusCode) {
      const reason = e.agent.lastDialError || (await e.agent.diagnose().catch(() => null));
      if (reason) return new HostError(reason, 502);
    }
    return err;
  }

  /** Ping + info for one host, with timeout. */
  async probe(id) {
    const e = this.get(id);
    const t0 = Date.now();
    try {
      const info = await withTimeout(e.docker.info(), CALL_TIMEOUT, '连接');
      const latency = Date.now() - t0;
      if (e.agent) e.agent.lastDialError = null;
      e.status = {
        state: 'online',
        latency,
        checkedAt: Date.now(),
        info: {
          name: info.Name,
          serverVersion: info.ServerVersion,
          os: info.OperatingSystem,
          kernel: info.KernelVersion,
          arch: info.Architecture,
          cpus: info.NCPU,
          memTotal: info.MemTotal,
          containers: info.Containers,
          running: info.ContainersRunning,
          paused: info.ContainersPaused,
          stopped: info.ContainersStopped,
          images: info.Images,
          storageDriver: info.Driver,
          dockerRootDir: info.DockerRootDir,
          warnings: info.Warnings || [],
        },
      };
    } catch (err) {
      const explained = await this.explain(id, err);
      e.status = { state: 'offline', checkedAt: Date.now(), error: dockerError(explained).message, info: e.status.info };
    }
    return e.status;
  }

  async list({ probe = true } = {}) {
    if (probe) await Promise.all(this.order.map((id) => this.probe(id)));
    return this.order.map((id) => {
      const e = this.entries.get(id);
      return { ...publicView(e.cfg), address: describeAddress(e.cfg), status: e.status };
    });
  }

  publicHost(id) {
    const e = this.get(id);
    return { ...publicView(e.cfg), address: describeAddress(e.cfg), status: e.status };
  }

  /** Try a config without saving it. Returns info + fingerprint, or throws a friendly error. */
  async test(input, prevId) {
    const prev = prevId ? this.get(prevId).cfg : undefined;
    const cfg = { ...normalizeHost(input, prev), id: '__test__' };
    let fingerprint = null;
    const { docker, agent } = this.#createClient(cfg);
    if (agent) agent.opts.onHostKey = (fp) => (fingerprint = fp);
    const t0 = Date.now();
    try {
      const [info, version] = await withTimeout(Promise.all([docker.info(), docker.version()]), 12_000, '连接');
      return {
        ok: true,
        latency: Date.now() - t0,
        name: info.Name,
        serverVersion: version.Version,
        apiVersion: version.ApiVersion,
        os: info.OperatingSystem,
        containers: info.Containers,
        running: info.ContainersRunning,
        fingerprint: fingerprint || cfg.hostKey || null,
        fingerprintIsNew: !!fingerprint && !cfg.hostKey,
      };
    } catch (err) {
      let e = err;
      if (agent && !err?.code?.startsWith?.('HOST_KEY')) {
        const reason = agent.lastDialError || (await agent.diagnose().catch(() => null));
        if (reason) e = new HostError(reason, 502);
      }
      throw new HostError(humanizeDockerConnError(e, cfg), 502);
    } finally {
      agent?.destroy();
    }
  }

  #assertUnique(cfg, selfId) {
    const addr = describeAddress(cfg);
    for (const [id, e] of this.entries) {
      if (id !== selfId && describeAddress(e.cfg) === addr) throw new HostError(`该服务器已添加过：${e.cfg.name}（${addr}）`, 409);
    }
  }

  add(input) {
    const cfg = normalizeHost(input);
    this.#assertUnique(cfg);
    cfg.id = newId();
    this.#mount(cfg);
    this.#persist();
    return this.publicHost(cfg.id);
  }

  update(id, input) {
    const prev = this.get(id).cfg;
    const cfg = normalizeHost(input, prev);
    cfg.id = id;
    this.#assertUnique(cfg, id);
    this.#unmount(id);
    this.#mount(cfg);
    this.#persist();
    return this.publicHost(id);
  }

  remove(id) {
    this.get(id);
    this.#unmount(id);
    this.order = this.order.filter((x) => x !== id);
    this.#persist();
  }

  reorder(ids) {
    if (ids.length !== this.order.length || !ids.every((id) => this.entries.has(id))) throw new HostError('排序参数无效');
    this.order = [...ids];
    this.#persist();
  }
}

function humanizeDockerConnError(err, cfg) {
  const m = err?.message || err?.errors?.[0]?.message || String(err);
  if (cfg.type === 'local' && /ENOENT|EACCES/.test(m)) {
    return /EACCES/.test(m)
      ? `没有权限访问 ${cfg.socketPath}（面板进程需要加入 docker 组或以 root 运行）`
      : `找不到 ${cfg.socketPath}：本机未安装 Docker 或 Docker 未运行（容器部署时需要挂载 docker.sock）`;
  }
  if (cfg.type === 'tcp') {
    if (/ECONNREFUSED/.test(m) || err?.code === 'ECONNREFUSED') {
      return `无法连接 ${cfg.host}:${cfg.port}：连接被拒绝（Docker 是否开启了 TCP 监听？）`;
    }
    if (/self[- ]signed|unable to verify|certificate|SSL|EPROTO|wrong version number/i.test(m)) {
      return `TLS 握手失败：${m}（请检查证书是否匹配，或该端口是否确实启用了 TLS）`;
    }
    if (/ETIMEDOUT|超时/.test(m)) return `连接 ${cfg.host}:${cfg.port} 超时：请检查网络和防火墙`;
    if (/HTTP request to an HTTPS server/i.test(m)) return '该端口启用了 TLS，请打开「TLS」并填写证书';
  }
  return dockerError(err).message || m;
}

export const hosts = new HostManager();
export { SECRET_FIELDS };
