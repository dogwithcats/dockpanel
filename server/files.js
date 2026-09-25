import { PassThrough } from 'node:stream';
import { dockerError } from './docker.js';

/**
 * Container file access.
 *
 * The panel talks to the Docker API only, so to touch a bind mount we start a tiny helper container that
 * shares the same host path (`HostConfig.Binds: ["<source>:<target>:rw"]`) and use exec + the archive API
 * inside it. Nothing is written through the Docker daemon directly, which keeps this working for remote
 * hosts (SSH / TLS) exactly like it does locally.
 *
 * Volume mounts are not supported: their data lives under the daemon's internal directory, which the helper
 * would have to know about. Use the terminal for those.
 *
 * A bind mount's source can be a directory or a single file (`-v ./nginx.conf:/etc/nginx/nginx.conf`).
 * The helper mounts it at /mnt/vol either way and records which one it got (`helper.kind`):
 *   dir  – full browser: list, edit, upload, mkdir, rename, delete
 *   file – one entry: view, edit (written in place, see writeFile), download, chmod
 */

const HELPER_LABEL = 'dockpanel.file-helper';
const IDLE_MS = 120_000;
const EXEC_TIMEOUT = 20_000;

/** Preferred helper images, cheapest/leanest first. $FILE_HELPER_IMAGE wins if set. */
const CANDIDATES = ['alpine:latest', 'busybox:latest', 'debian:stable-slim', 'ubuntu:latest'];

const helpers = new Map(); // key "image\u0000source" -> { container, id, refs, idleAt, validatedAt, kind, lsFlags }

setInterval(() => {
  const now = Date.now();
  for (const [key, h] of helpers) {
    if (h.refs === 0 && now - h.idleAt > IDLE_MS) {
      h.container.remove({ force: true }).catch(() => {});
      helpers.delete(key);
    }
  }
}, 30_000).unref();

export class FileError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * POSIX single-quote a value so it can be embedded in a shell command:
 *   plain -> 'plain',  it's -> 'it'\''s'
 * Safe for spaces, quotes, globs, $ and newlines.
 */
function q(value) {
  return "'" + String(value).split("'").join("'\\''") + "'";
}

async function withTimeout(promise, ms, what) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new FileError(`${what}超时（${ms / 1000}s）`, 504)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

async function pickImage(docker) {
  if (process.env.FILE_HELPER_IMAGE) return process.env.FILE_HELPER_IMAGE;
  const images = await docker.listImages().catch(() => []);
  const tags = new Set((images || []).flatMap((i) => i.RepoTags || []));
  return CANDIDATES.find((c) => tags.has(c)) || CANDIDATES[0];
}

/**
 * Get (or start) a helper container that has `source` mounted at /mnt/vol.
 * One helper per host is reused for every mount point of that host.
 */
async function acquireHelper(docker, source) {
  const image = await pickImage(docker);
  const key = `${image}\u0000${source}`;
  const cached = helpers.get(key);
  if (cached) {
    try {
      const info = await docker.getContainer(cached.id).inspect();
      if (info.State.Running && !(await mountWentStale(cached))) {
        cached.refs++;
        return { ...cached, release: () => release(cached) };
      }
      // A bind mount follows the inode captured at container start; if the host directory was replaced
      // (e.g. recreated by a deploy script) the helper keeps seeing the old, now empty directory.
      await cached.container.remove({ force: true }).catch(() => {});
    } catch {
      /* gone – recreate below */
    }
    helpers.delete(key);
  }

  // Remove stale helpers from earlier runs (e.g. after a panel restart)
  const stale = await docker.listContainers({ all: true, filters: { label: [HELPER_LABEL] } }).catch(() => []);
  await Promise.all(stale.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => {})));

  let container;
  try {
    container = await withTimeout(
      docker.createContainer({
        Image: image,
        Cmd: ['sh', '-c', 'while true; do sleep 30; done'],
        Labels: { [HELPER_LABEL]: source },
        // `Mounts` rather than `Binds`: Binds would create a missing source path as an empty directory on
        // the host, which is exactly wrong for a file that was just deleted or moved.
        HostConfig: { Mounts: [{ Type: 'bind', Source: source, Target: '/mnt/vol', ReadOnly: false }], AutoRemove: false },
      }),
      15_000,
      '创建文件助手容器',
    );
    await withTimeout(container.start(), 15_000, '启动文件助手容器');
  } catch (err) {
    await container?.remove({ force: true }).catch(() => {});
    throw new FileError(humanizeHelperError(err, image), err?.statusCode === 404 ? 404 : 500);
  }

  const entry = { container, id: container.id, refs: 1, idleAt: Date.now(), validatedAt: Date.now(), kind: 'dir' };
  try {
    entry.kind = await mountKind(entry);
  } catch (err) {
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }
  helpers.set(key, entry);
  return { ...entry, release: () => release(entry) };
}

/** What the helper sees at /mnt/vol: a directory, a single file, or nothing usable. */
async function mountKind(helper) {
  // `(: < path)` really opens the file: on Docker Desktop a replaced file still passes `-e` but can't be read
  const r = await sh(helper, 'if [ -d /mnt/vol ]; then echo dir; elif (: < /mnt/vol) 2>/dev/null; then echo file; else echo missing; fi', {
    timeout: 8000,
  });
  const kind = r.stdout.trim();
  if (kind === 'missing') throw new FileError('挂载的宿主机路径已不存在（可能被删除或移动）', 404);
  return kind === 'file' ? 'file' : 'dir';
}

/**
 * True when the helper's bind mount no longer shows what the host path contains.
 *
 * A bind mount pins the inode that existed when the helper started. When the host path is replaced rather
 * than modified – a deploy script recreating a directory, or vim / `sed -i` saving a file by writing a new
 * file and renaming it over the old one – the helper keeps looking at the old inode:
 *   directory → shows up empty
 *   file      → unlinked (link count 0) on Linux; "No such file" on Docker Desktop
 * Editing an unlinked file would silently lose the change, so file mounts are checked on every use; the
 * directory check is throttled.
 */
async function mountWentStale(helper, ttlMs = 20_000) {
  if (helper.kind === 'dir' && Date.now() - helper.validatedAt < ttlMs) return false;
  const probe = await sh(
    helper,
    `if [ -d /mnt/vol ]; then [ -n "$(ls -A /mnt/vol 2>/dev/null | head -1)" ] && echo ok || echo empty
elif (: < /mnt/vol) 2>/dev/null; then [ "$(stat -c %h /mnt/vol 2>/dev/null)" = 0 ] && echo gone || echo ok
else echo gone; fi`,
    { timeout: 5000 },
  ).catch(() => null);
  helper.validatedAt = Date.now();
  const state = probe?.stdout.trim();
  return state === 'empty' || state === 'gone'; // a helper is cheap to rebuild; stale data is not
}

/** Path inside the helper for `rel`, honouring single-file mounts (whose only entry is the file itself). */
function helperPath(helper, mount, rel) {
  const clean = cleanRel(rel);
  if (helper.kind !== 'file') return clean ? `/mnt/vol/${clean}` : '/mnt/vol';
  if (clean && clean !== mountBaseName(mount)) throw new FileError('这个挂载点是单个文件，没有其他条目', 404);
  return '/mnt/vol';
}

function requireDir(helper, what) {
  if (helper.kind === 'file') throw new FileError(`这个挂载点是单个文件，不能${what}，只能查看、编辑、下载和修改权限`);
}

const mountBaseName = (mount) => mount.target.split('/').filter(Boolean).pop() || 'file';

function release(entry) {
  entry.refs = Math.max(0, entry.refs - 1);
  entry.idleAt = Date.now();
}

function humanizeHelperError(err, image) {
  const msg = dockerError(err).message;
  if (/no such image|image .* not found|pull access denied/i.test(msg)) {
    return `找不到文件助手镜像 ${image}，请先拉取：docker pull ${image}（或用 FILE_HELPER_IMAGE 指定）`;
  }
  if (/bind source path does not exist/i.test(msg)) {
    return '挂载的宿主机路径已不存在（可能被删除或移动），重建容器后再试';
  }
  if (/permission denied|not permitted|operation not permitted/i.test(msg)) {
    return `当前 Docker 用户没有创建容器的权限，无法访问文件：${msg}`;
  }
  return msg;
}

/**
 * Run a shell command in the helper container.
 *
 * Regular (non-upgrade) exec streams are a single multiplexed socket without a `.stderr`, so stdout and
 * stderr are split with docker-modem's demuxStream. TTY exec streams are already merged.
 */
async function sh(helper, cmd, { timeout = EXEC_TIMEOUT, tty = false } = {}) {
  const exec = await withTimeout(
    helper.container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true, Tty: !!tty }),
    8000,
    '创建执行会话',
  );
  const stream = await exec.start({ hijack: true, stdin: false, Tty: !!tty });
  const stdout = [];
  const stderr = [];
  if (tty) stream.on('data', (d) => stdout.push(d));
  else {
    const out = new PassThrough();
    const err = new PassThrough();
    out.on('data', (d) => stdout.push(d));
    err.on('data', (d) => stderr.push(d));
    helper.container.modem.demuxStream(stream, out, err);
  }
  await withTimeout(
    new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
    }),
    timeout,
    '执行命令',
  );
  const code = await exec.inspect().then((r) => r.ExitCode).catch(() => null);
  return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code };
}

async function shOk(helper, cmd) {
  const r = await sh(helper, cmd);
  if (r.code !== 0) throw new FileError(r.stderr.trim() || `命令失败（exit ${r.code}）`, 400);
  return r.stdout;
}

/* ------------------------------------------------------------------- mounts */

/** Normalize a daemon mount object (capitalized fields) into the shape used throughout this module. */
function normalizeMount(m) {
  const browsable = m.Type === 'bind';
  return {
    type: m.Type,
    source: m.Source,
    target: m.Destination,
    rw: !!m.RW,
    name: m.Name || null,
    browsable,
    reason: browsable ? null : '数据卷由 Docker 管理，请使用终端操作（或改用宿主机目录挂载）',
  };
}

/**
 * Mounts of a container that are reachable through a host path (bind mounts and path-backed volumes).
 * Writable mounts come first so the file browser opens something the user can actually edit.
 */
export function fileMounts(info) {
  return (info.Mounts || [])
    .map(normalizeMount)
    .sort((a, b) => Number(b.browsable) - Number(a.browsable) || Number(b.rw) - Number(a.rw) || a.target.localeCompare(b.target));
}

export function resolveMount(info, mountTarget) {
  const mounts = fileMounts(info);
  // Without an explicit target, prefer a writable browsable mount, then any browsable mount.
  // (A container often mounts the same host path twice, e.g. rw at /data and ro at /data-ro.)
  const target =
    mountTarget ||
    mounts.find((m) => m.browsable && m.rw)?.target ||
    mounts.find((m) => m.browsable)?.target ||
    mounts[0]?.target;
  if (!target) {
    throw new FileError(mounts.length ? '该容器没有可浏览的挂载点（数据卷请使用终端操作）' : '该容器没有挂载任何目录', 404);
  }
  const mount = mounts.find((m) => m.target === target);
  if (!mount) throw new FileError(`容器没有挂载点 ${target}`, 404);
  if (!mount.browsable) {
    throw new FileError(`挂载点 ${mount.target} 是数据卷${mount.name ? `（${mount.name}）` : ''}，内容由 Docker 管理，无法通过文件管理编辑`);
  }
  if (!mount.source) throw new FileError(`挂载点 ${mount.target} 没有可访问的宿主机路径`);
  return mount;
}

/* ------------------------------------------------------------------ listing */

/**
 * Listing uses the container's own `ls` rather than parsing the tar stream: names with spaces or quotes
 * survive as the last field of each line. GNU ls is preferred (gives a real mtime); busybox output is
 * accepted as a fallback with a year-only timestamp.
 */
// Pin the locale so flags, sorting and date format are predictable.
const LS_ENV = 'LC_ALL=C';

/**
 * List a directory of the mount. For a single-file mount the listing is that one file, named after the
 * mount target (so `/etc/nginx/nginx.conf` shows up as `nginx.conf`), and `kind: 'file'` tells the UI.
 */
export async function listDir(docker, mount, relPath) {
  const helper = await acquireHelper(docker, mount.source);
  try {
    const flags = await lsFlags(helper);
    if (helper.kind === 'file') {
      if (cleanRel(relPath)) throw new FileError('这个挂载点是单个文件，没有子目录', 404);
      const r = await sh(helper, `${LS_ENV} ls ${flags} -d /mnt/vol 2>&1`, { timeout: 10_000 });
      const { entries } = parseLs(r.stdout);
      if (r.code !== 0 || !entries.length) throw new FileError(r.stdout.trim() || '无法读取挂载的文件', 404);
      return { entries: [{ ...entries[0], name: mountBaseName(mount) }], path: '', truncated: false, kind: 'file' };
    }
    const dir = cleanRel(relPath) || '.';
    const r = await sh(helper, `cd /mnt/vol && cd ${q(dir)} 2>&1 && ${LS_ENV} ls ${flags} ./ 2>&1`, { timeout: 20_000 });
    if (r.code !== 0) throw new FileError(r.stderr.trim() || r.stdout.trim() || '无法进入目录', 404);
    const { entries, truncated } = parseLs(r.stdout);
    return { entries, path: dir === '.' ? '' : dir, truncated, kind: 'dir' };
  } finally {
    helper.release();
  }
}

/**
 * `ls -lAnF` is supported by both GNU coreutils and busybox. GNU additionally understands
 * `--time-style=+%s`, which gives an unambiguous epoch timestamp, so it is used when available.
 * The probe must look at stdout: busybox only reports unsupported flags on stderr and exits 1.
 */
const LS_FALLBACK = '-lAnF';
const LS_GNU = '-lAnF --time-style=+%s';

async function lsFlags(helper) {
  if (helper.lsFlags) return helper.lsFlags;
  // `-d /mnt/vol` always yields one entry line, whether the mount is a directory, a file or empty
  const probe = await sh(helper, `${LS_ENV} ls ${LS_GNU} -d /mnt/vol 2>/dev/null`);
  const hasEntry = probe.stdout.split('\n').some((l) => /^\s*[-bcdlps][rwxsStT-]{9}\s+\d+\s/.test(l));
  helper.lsFlags = hasEntry ? LS_GNU : LS_FALLBACK;
  return helper.lsFlags;
}

const MAX_ENTRIES = 3000;

/**
 * Parse `ls -lAnF` output.
 *
 * Two shapes are supported (name always last, so spaces in names survive):
 *   -rw-r--r-- 1 root root 4096 1737760000 conf.d                                    (GNU --time-style=+%s)
 *   -rw-r--r--    1 0        0               64 Sep 25 09:41 conf.d/                  (busybox)
 *   lrwxrwxrwx 1 root root   10 2026-01-10 09:30 link.conf -> nginx.conf             (GNU --full-time)
 */
export function parseLs(output) {
  const entries = [];
  let truncated = false;
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('total ')) continue;
    const parsed = matchLine(line);
    if (!parsed) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push(parsed);
  }
  return { entries, truncated };
}

const HEAD = /^\s*([bcdlps-])([rwxsStT-]{9})\s+\d+\s+(\S+)\s+(\S+)\s+(\d[\d,]*)\s+(.*)$/;
const EPOCH = /^(\d{9,})\s+(.+)$/;
const FULL_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s+(?:[+-]\d{4}\s+)?(.+)$/;
const SHORT_TIME = /^([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}))\s+(.+)$/;

function matchLine(line) {
  const head = HEAD.exec(line);
  if (!head) return null;
  const [, type, perms, uid, gid, sizeRaw, remainder] = head;
  const size = Number(sizeRaw.replace(/,/g, '')) || 0;

  let timeRaw = null;
  let tail = null;
  for (const [re, timeFrom] of [
    [EPOCH, (m) => m[1]],
    [FULL_TIME, (m) => `${m[1]} ${m[2]}`],
    [SHORT_TIME, (m) => m[1]],
  ]) {
    const m = re.exec(remainder);
    if (!m) continue;
    timeRaw = timeFrom(m);
    tail = m[m.length - 1];
    if (tail) break;
    timeRaw = null;
  }
  if (timeRaw === null || !tail) return null;

  const arrow = tail.indexOf(' -> ');
  const nameWithFlag = arrow >= 0 ? tail.slice(0, arrow) : tail;
  const linkTarget = arrow >= 0 ? tail.slice(arrow + 4) : null;
  const name = nameWithFlag.replace(/^(?:\.\/)+/, '').replace(/[/@*=]$/, '');
  if (!name || name === '.' || name === '..') return null;

  return {
    name,
    type: type === 'd' ? 'dir' : type === '-' ? 'file' : type === 'l' ? 'link' : 'special',
    size,
    uid,
    gid,
    mode: Number.parseInt(permToOctal(perms), 8),
    mtime: parseTime(timeRaw),
    exec: type === '-' && perms.includes('x'),
    linkTarget,
  };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** busybox omits the year for recent files and Date.parse() guesses badly, so parse it explicitly. */
function parseTime(raw) {
  if (/^\d{9,}$/.test(raw)) return Number(raw) * 1000;
  const full = /^(\d{4})-(\d{2})-(\d{2})(?::?\s?(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (full) {
    return Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4] || 0), Number(full[5] || 0), Number(full[6] || 0));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, mo, d] = raw.split('-').map(Number);
    return Date.UTC(y, mo - 1, d);
  }
  const m = /^(\w{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  if (m[3]) return Date.UTC(Number(m[3]), month, day);
  const now = new Date();
  const at = (year) => Date.UTC(year, month, day, Number(m[4]), Number(m[5]));
  const thisYear = at(now.getUTCFullYear());
  return thisYear - Date.now() > 24 * 3600_000 ? at(now.getUTCFullYear() - 1) : thisYear;
}

function permToOctal(p) {
  const bits = (s) => (s[0] === 'r' ? 4 : 0) + (s[1] === 'w' ? 2 : 0) + (/[xsStT]/.test(s[2]) ? 1 : 0);
  return `${bits(p.slice(0, 3))}${bits(p.slice(3, 6))}${bits(p.slice(6, 9))}`;
}

/* -------------------------------------------------------------- file read/write */

export function humanFileError(err) {
  const msg = dockerError(err).message;
  return new FileError(msg, err?.statusCode && err.statusCode >= 400 ? err.statusCode : 500);
}

function cleanRel(rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  if (clean.split('/').some((s) => s === '..')) throw new FileError('非法路径');
  if (clean.includes('\0')) throw new FileError('非法路径');
  return clean;
}

export const isTextName = (name) => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return !BINARY_EXT.has(ext) && !name.endsWith('~');
};

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','webp','bmp','ico','icns','tiff','avif',
  'zip','gz','tgz','bz2','xz','zst','7z','rar','jar','war','whl','deb','rpm','apk','dmg','iso',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods',
  'so','o','a','class','pyc','wasm','woff','woff2','ttf','otf','eot','mp3','mp4','mov','avi','mkv','wav','flac','sqlite','db','bin','exe','dll','dat','cache',
]);

export async function readFile(docker, mount, rel, maxBytes = 8 * 1024 * 1024) {
  const helper = await acquireHelper(docker, mount.source);
  try {
    const p = helperPath(helper, mount, rel);
    const st = await sh(helper, `stat -c '%F|%s|%a|%Y' ${q(p)} 2>&1 || (ls -ld ${q(p)} >/dev/null 2>&1 && ls -ldn ${q(p)})`, { timeout: 8000 });
    if (st.code !== 0) throw new FileError(st.stderr.trim() || '文件不存在', 404);
    const info = (await sh(helper, `test -d ${q(p)} && echo dir || echo file`)).stdout.trim();
    if (info === 'dir') throw new FileError('这是一个目录', 400);
    const size = Number((await sh(helper, `stat -c %s ${q(p)} 2>/dev/null || wc -c < ${q(p)}`)).stdout.trim().split('\n')[0]) || 0;
    if (size > maxBytes) throw new FileError(`文件过大（${Math.round(size / 1024 / 1024)} MB），请下载后再编辑`, 413);
    const content = await sh(helper, `cat ${q(p)}`, { timeout: 30_000 });
    if (content.code !== 0) throw new FileError(content.stderr.trim() || '读取失败', 400);
    return { content: Buffer.from(content.stdout, 'utf8'), size };
  } finally {
    helper.release();
  }
}

/** Minimal ustar entry for a single regular file. */
export function tarFile(name, data, mode = 0o644) {
  const header = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 99) throw new FileError('文件名过长');
  nameBuf.copy(header, 0);
  header.write('0000644', 100, 7, 'ascii');
  header.write('0000000', 108, 7, 'ascii');
  header.write('0000000', 116, 7, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  void mode;
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad), Buffer.alloc(1024)]);
}

/** Extract a single file from a tar stream produced by the archive API. */
export function untarFirst(buf) {
  if (buf.length < 512) throw new FileError('归档内容为空');
  const size = parseInt(buf.toString('ascii', 124, 136).trim() || '0', 8);
  const type = buf.toString('ascii', 156, 157);
  if (type && type !== '0' && type !== '\0') throw new FileError('目标不是普通文件（可能是目录或链接）');
  return buf.subarray(512, 512 + size);
}

export async function writeFile(docker, mount, rel, data) {
  if (!mount.rw) throw new FileError(`挂载点 ${mount.target} 是只读的，无法写入`);
  const helper = await acquireHelper(docker, mount.source);
  try {
    let script;
    if (helper.kind === 'file') {
      // A single-file bind mount cannot be replaced (rename over it fails with EBUSY), and replacing it
      // would detach it from the app container anyway. Stage the upload in the helper, then overwrite the
      // file in place – the app container sees the change immediately, and a dropped upload never leaves
      // the real file half-written.
      const target = helperPath(helper, mount, rel);
      const tmp = `/tmp/dp-upload-${Date.now()}`;
      script = `cat > ${q(tmp)} && cat ${q(tmp)} > ${q(target)}; rc=$?; rm -f ${q(tmp)}; exit $rc`;
    } else {
      const clean = cleanRel(rel);
      if (!clean) throw new FileError('缺少文件路径');
      const name = clean.slice(clean.lastIndexOf('/') + 1);
      if (!name || name === '.' || name === '..') throw new FileError('非法文件名');
      const dir = clean.includes('/') ? `/mnt/vol/${clean.slice(0, clean.lastIndexOf('/'))}` : '/mnt/vol';
      // Temp file next to the target → the final `mv` is an atomic rename on the same filesystem
      const tmp = `${dir}/.${name}.dp-tmp-${Date.now()}`;
      // Copy the old mode so a rewrite doesn't reset permissions (e.g. an executable script)
      const existing = await sh(helper, `stat -c %a ${q(`/mnt/vol/${clean}`)} 2>/dev/null || echo ''`);
      const mode = /^[0-7]{3,4}$/.test(existing.stdout.trim()) ? existing.stdout.trim() : '644';
      script = `cat > ${q(tmp)} && chmod ${mode} ${q(tmp)} && mv -f ${q(tmp)} ${q(`/mnt/vol/${clean}`)} || { rm -f ${q(tmp)}; exit 1; }`;
    }

    // Stream the new content into the helper
    const exec = await helper.container.exec({
      Cmd: ['sh', '-c', script],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    await new Promise((resolve, reject) => {
      const out = new PassThrough();
      const err = new PassThrough();
      const errText = [];
      out.on('data', () => {});
      err.on('data', (d) => errText.push(d));
      helper.container.modem.demuxStream(stream, out, err);
      stream.on('error', reject);
      stream.on('end', () => {
        const text = Buffer.concat(errText).toString('utf8').trim();
        if (text) reject(new FileError(text, 400));
        else resolve();
      });
      // stdin must be ended or the remote `cat` never finishes
      stream.end(data || Buffer.alloc(0));
    });
    return { ok: true };
  } finally {
    helper.release();
  }
}

export async function uploadArchive(docker, mount, rel, archive, { overwrite = true } = {}) {
  if (!mount.rw) throw new FileError(`挂载点 ${mount.target} 是只读的，无法写入`);
  const helper = await acquireHelper(docker, mount.source);
  try {
    requireDir(helper, '上传');
    const clean = cleanRel(rel);
    const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '.';
    if (!overwrite) {
      // Refuse to clobber an existing file unless asked to
      const existing = await sh(helper, `test -e ${q(`/mnt/vol/${clean}`)} && echo yes || echo no`, { timeout: 8000 });
      if (existing.stdout.trim() === 'yes') throw new FileError('同名文件已存在', 409);
    }
    await helper.container.putArchive(archive, { path: `/mnt/vol/${dir}` });
    return { ok: true };
  } catch (err) {
    throw humanFileError(err);
  } finally {
    helper.release();
  }
}

/** Stream a file out of the helper for downloads. */
const MIME = {
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  json: 'application/json', yml: 'text/yaml; charset=utf-8', yaml: 'text/yaml; charset=utf-8',
  conf: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', env: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', xml: 'application/xml',
  sh: 'text/x-shellscript; charset=utf-8', sql: 'application/sql', pem: 'application/x-pem-file',
  crt: 'application/x-x509-ca-cert', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  mp4: 'video/mp4', mp3: 'audio/mpeg', woff2: 'font/woff2', ttf: 'font/ttf',
};

function guessMime(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return MIME[ext] || 'application/octet-stream';
}

/** Stream a file (or a directory as .tar), and report a sensible content type. */
export async function downloadStream(docker, mount, rel) {
  const helper = await acquireHelper(docker, mount.source);
  let stream;
  try {
    const p = helperPath(helper, mount, rel);
    const isDir = (await sh(helper, `test -d ${q(p)} && echo dir || echo file`, { timeout: 8000 })).stdout.trim() === 'dir';
    if (isDir) {
      const dir = cleanRel(rel);
      const base = dir.split('/').pop() || 'root';
      return {
        stream: await shTarStream(helper, `tar -cf - -C ${q(dir ? `/mnt/vol/${dir}` : '/mnt/vol')} .`),
        name: `${base}.tar`,
        type: 'application/x-tar',
        release: helper.release,
      };
    }
    stream = await helper.container.getArchive({ path: p });
  } catch (err) {
    helper.release();
    throw humanFileError(err);
  }
  const pass = new PassThrough();
  const chunks = [];
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    helper.release();
  };
  stream.on('data', (c) => chunks.push(c));
  stream.on('error', (e) => {
    done();
    pass.destroy(e);
  });
  stream.on('end', () => {
    try {
      pass.end(untarFirst(Buffer.concat(chunks)));
    } catch (e) {
      pass.destroy(e);
    }
    done();
  });
  const name = helper.kind === 'file' ? mountBaseName(mount) : cleanRel(rel).split('/').pop() || 'file';
  return { stream: pass, name, type: guessMime(name), release: done };
}

/** Run a command whose stdout is piped to the caller (used for tar of a directory). */
async function shTarStream(helper, cmd) {
  const exec = await helper.container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true, Tty: true });
  const stream = await exec.start({ hijack: true, stdin: false, Tty: true });
  return stream;
}

export async function mkdir(docker, mount, rel, mode = '755') {
  if (!mount.rw) throw new FileError('挂载点是只读的');
  const helper = await acquireHelper(docker, mount.source);
  try {
    requireDir(helper, '新建目录');
    await shOk(helper, `mkdir -p -m ${q(mode)} ${q(helperPath(helper, mount, rel))}`);
    return { ok: true };
  } finally {
    helper.release();
  }
}

/**
 * Delete a file, or a directory.
 *
 * Directories are removed recursively only when `recursive` is set – a mistyped path should not be able to
 * wipe a subtree. The script exits non-zero (with a message) whenever it refuses.
 */
export async function removePath(docker, mount, rel, { recursive = false } = {}) {
  if (!mount.rw) throw new FileError(`挂载点 ${mount.target} 是只读的，无法删除`);
  const clean = cleanRel(rel);
  if (!clean) throw new FileError('不能删除挂载根目录');
  const helper = await acquireHelper(docker, mount.source);
  try {
    requireDir(helper, '删除');
    const p = `/mnt/vol/${clean}`;
    const script = `p=${q(p)}
if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "文件不存在：${clean}" >&2; exit 3; fi
if [ -d "$p" ] && [ ! -L "$p" ]; then
  if [ ${recursive ? '1' : '0'} -eq 1 ]; then
    rm -rf -- "$p" || { echo "删除目录失败" >&2; exit 5; }
  else
    rmdir -- "$p" 2>/dev/null || { echo "目录不为空，请先删除里面的内容（或勾选递归删除）" >&2; exit 4; }
  fi
else
  rm -f -- "$p" || { echo "删除文件失败" >&2; exit 5; }
fi`;
    const r = await sh(helper, script, { timeout: 60_000 });
    if (r.code !== 0) throw new FileError(r.stderr.trim() || r.stdout.trim() || `删除失败（exit ${r.code}）`, 400);
    return { ok: true };
  } finally {
    helper.release();
  }
}

export async function rename(docker, mount, from, to) {
  if (!mount.rw) throw new FileError('挂载点是只读的');
  const helper = await acquireHelper(docker, mount.source);
  try {
    requireDir(helper, '重命名');
    const cleanTo = cleanRel(to);
    if (!cleanTo) throw new FileError('缺少目标路径');
    const parent = cleanTo.includes('/') ? cleanTo.slice(0, cleanTo.lastIndexOf('/')) : '';
    if (parent) await sh(helper, `mkdir -p ${q(`/mnt/vol/${parent}`)} 2>/dev/null`);
    await shOk(helper, `mv -- ${q(helperPath(helper, mount, from))} ${q(`/mnt/vol/${cleanTo}`)} 2>&1`);
    return { ok: true };
  } finally {
    helper.release();
  }
}

export async function chmod(docker, mount, rel, mode) {
  if (!mount.rw) throw new FileError('挂载点是只读的');
  if (!/^[0-7]{3,4}$/.test(String(mode))) throw new FileError('权限格式无效，应为 644 / 0755 这样的形式');
  const helper = await acquireHelper(docker, mount.source);
  try {
    await shOk(helper, `chmod ${q(mode)} ${q(helperPath(helper, mount, rel))} 2>&1`);
    return { ok: true };
  } finally {
    helper.release();
  }
}
