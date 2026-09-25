import crypto from 'node:crypto';
import http from 'node:http';
import { Client } from 'ssh2';

/**
 * HTTP agent that talks to a remote Docker daemon through `docker system dial-stdio` over SSH
 * (the same mechanism as `docker -H ssh://user@host`).
 *
 * Unlike docker-modem's built-in SSH support (one SSH handshake per HTTP request) this keeps a
 * small pool of persistent SSH connections and opens one cheap channel per request. OpenSSH limits
 * sessions per connection (MaxSessions, default 10), so a new connection is opened when the
 * existing ones are busy – long-lived log/terminal/stats streams each hold a channel.
 */
const MAX_CHANNELS_PER_CONN = 8;

export function sha256Fingerprint(keyBuffer) {
  return `SHA256:${crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '')}`;
}

export class SshDockerAgent extends http.Agent {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.username
   * @param {string} [opts.privateKey]
   * @param {string} [opts.passphrase]
   * @param {string} [opts.password]
   * @param {string} [opts.hostKey]           expected SHA256 fingerprint (TOFU); empty = accept & report
   * @param {(fp: string) => void} [opts.onHostKey]  called with the fingerprint seen on connect
   * @param {string} [opts.dockerCommand]     remote command, default "docker system dial-stdio"
   */
  constructor(opts) {
    super({ keepAlive: false, maxSockets: Infinity });
    this.opts = opts;
    this.pool = []; // { client, ready: Promise, channels, dead }
    this.closed = false;
    this.lastDialError = null;
  }

  #connect() {
    const { host, port, username, privateKey, passphrase, password, hostKey, onHostKey } = this.opts;
    const client = new Client();
    const entry = { client, channels: 0, dead: false, lastUsed: Date.now() };
    let seenFingerprint = null;

    entry.ready = new Promise((resolve, reject) => {
      client
        .once('ready', () => {
          if (seenFingerprint) onHostKey?.(seenFingerprint);
          resolve(client);
        })
        .once('error', (err) => {
          entry.dead = true;
          reject(humanizeSshError(err, this.opts));
        })
        .once('close', () => {
          entry.dead = true;
          this.pool = this.pool.filter((e) => e !== entry);
        })
        .connect({
          host,
          port: port || 22,
          username,
          privateKey: privateKey || undefined,
          passphrase: passphrase || undefined,
          password: password || undefined,
          readyTimeout: 10_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          hostVerifier: (key) => {
            seenFingerprint = sha256Fingerprint(key);
            if (hostKey && hostKey !== seenFingerprint) {
              entry.hostKeyMismatch = seenFingerprint;
              return false;
            }
            return true;
          },
        });
    });
    // Surface host key mismatches with a precise message
    entry.ready = entry.ready.catch((err) => {
      if (entry.hostKeyMismatch) {
        const e = new Error(
          `SSH 主机指纹不匹配！预期 ${hostKey}，实际 ${entry.hostKeyMismatch}。` +
            '如果服务器重装过系统或更换过 SSH 密钥，请在服务器管理中重置指纹；否则可能存在中间人攻击。',
        );
        e.code = 'HOST_KEY_MISMATCH';
        e.fingerprint = entry.hostKeyMismatch;
        throw e;
      }
      throw err;
    });
    this.pool.push(entry);
    return entry;
  }

  async #acquire() {
    if (this.closed) throw new Error('连接已关闭');
    let entry = this.pool.find((e) => !e.dead && e.channels < MAX_CHANNELS_PER_CONN);
    if (!entry) entry = this.#connect();
    entry.channels++;
    try {
      const client = await entry.ready;
      return { entry, client };
    } catch (err) {
      entry.channels--;
      this.pool = this.pool.filter((e) => e !== entry);
      throw err;
    }
  }

  /** Open a raw stdio channel to the remote docker daemon. */
  async openStream() {
    const { entry, client } = await this.#acquire();
    const cmd = this.opts.dockerCommand || 'docker system dial-stdio';
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) {
          entry.channels--;
          // Channel refused (MaxSessions reached): retire this connection for new channels and retry
          if (/open failed|channel/i.test(err.message) && entry.channels > 0) {
            entry.dead = true;
            return this.openStream().then(resolve, reject);
          }
          return reject(err);
        }
        let stderr = '';
        stream.stderr?.on('data', (d) => {
          if (stderr.length < 2000) stderr += d.toString();
        });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          entry.channels--;
          entry.lastUsed = Date.now();
        };
        // Remote failures (no docker CLI, no permission) only show up on stderr + a non-zero exit; the HTTP layer
        // just sees "socket hang up". Remember the reason so callers can report something useful.
        stream.once('exit', (code) => {
          if (code) this.lastDialError = humanizeDialError(stderr || `exit ${code}`);
        });
        stream.once('close', release);
        // net.Socket-ish shims used by http.ClientRequest
        stream.setTimeout = () => stream;
        stream.setNoDelay = () => stream;
        stream.setKeepAlive = () => stream;
        stream.ref = () => stream;
        stream.unref = () => stream;
        stream.destroySoon = () => stream.end();
        resolve(stream);
      });
    });
  }

  /** Run a one-off command over SSH (used to diagnose connection problems). */
  async exec(cmd, timeoutMs = 10_000) {
    const { entry, client } = await this.#acquire();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`命令超时：${cmd}`)), timeoutMs);
        client.exec(cmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            return reject(err);
          }
          let out = '';
          let errOut = '';
          stream.on('data', (d) => (out += d));
          stream.stderr.on('data', (d) => (errOut += d));
          stream.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: out.trim(), stderr: errOut.trim() });
          });
        });
      });
    } finally {
      entry.channels--;
    }
  }

  /** Explain why the remote docker can't be reached, or null if it can. */
  async diagnose() {
    const r = await this.exec("docker version --format '{{.Server.Version}}'");
    if (r.code === 0) return null;
    return humanizeDialError(r.stderr || r.stdout || `exit ${r.code}`);
  }

  createConnection(_options, cb) {
    this.openStream().then(
      (stream) => cb(null, stream),
      (err) => cb(err),
    );
  }

  /** Close idle SSH connections (called periodically). */
  reapIdle(maxIdleMs = 5 * 60_000) {
    const now = Date.now();
    for (const e of this.pool) {
      if (!e.dead && e.channels === 0 && now - e.lastUsed > maxIdleMs) {
        e.dead = true;
        e.client.end();
      }
    }
  }

  destroy() {
    this.closed = true;
    for (const e of this.pool) e.client.end();
    this.pool = [];
    super.destroy();
  }
}

function humanizeSshError(err, { host, port, username }) {
  const target = `${username}@${host}:${port || 22}`;
  const m = err?.message || String(err);
  let msg = m;
  if (err.level === 'client-authentication' || /authentication methods failed/i.test(m)) {
    msg = `SSH 认证失败（${target}）：请检查用户名、私钥或密码`;
  } else if (/ECONNREFUSED/.test(m)) msg = `无法连接 ${target}：连接被拒绝（SSH 端口是否正确？）`;
  else if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(m)) msg = `连接 ${target} 超时：请检查网络和防火墙`;
  else if (/ENOTFOUND|EAI_AGAIN/.test(m)) msg = `无法解析主机名 ${host}`;
  else if (/EHOSTUNREACH|ENETUNREACH/.test(m)) msg = `主机 ${host} 不可达`;
  else if (/Cannot parse privateKey|Encrypted private OpenSSH key detected|bad passphrase/i.test(m)) {
    msg = `私钥无法解析：${m}（加密的私钥需要填写口令）`;
  } else if (/Host denied|verification failed/i.test(m)) msg = `主机指纹校验失败（${target}）`;
  const e = new Error(msg);
  e.cause = err;
  return e;
}

function humanizeDialError(stderr) {
  const s = stderr.trim();
  if (/command not found|not found/i.test(s)) return `远程服务器未安装 docker 命令：${s}`;
  if (/permission denied/i.test(s)) {
    return `远程用户没有 Docker 权限：${s}（请将该用户加入 docker 组：sudo usermod -aG docker <用户>）`;
  }
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(s)) return `远程 Docker 未运行：${s}`;
  return s;
}
