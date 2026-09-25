import express from 'express';
import { audit } from './audit.js';
import { clientIp } from './auth.js';
import { config } from './config.js';
import { containerName, dockerError } from './docker.js';
import {
  chmod,
  downloadStream,
  fileMounts,
  isTextName,
  listDir,
  mkdir,
  readFile,
  removePath,
  rename,
  resolveMount,
  uploadArchive,
  writeFile,
} from './files.js';
import { hosts, withTimeout } from './hosts.js';

const MAX_EDIT_BYTES = 8 * 1024 * 1024;

export const filesRouter = express.Router({ mergeParams: true });

/** Resolve container + mount, with a short cache of the inspect call. */
async function context(req) {
  const info = await withTimeout(req.docker.getContainer(req.params.id).inspect());
  const requested = req.query.mount || req.body?.mount;
  const mount = resolveMount(info, requested);
  return { info, mount };
}

function guardWritable(req) {
  if (config.readOnly) throw Object.assign(new Error('当前为只读模式'), { statusCode: 403 });
  if (config.allowFileWrite === false) throw Object.assign(new Error('文件写入已被禁用（ALLOW_FILE_WRITE=false）'), { statusCode: 403 });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** List the container's mounts and which ones can be browsed. */
filesRouter.get('/mounts', wrap(async (req, res) => {
  const info = await withTimeout(req.docker.getContainer(req.params.id).inspect());
  res.json({
    mounts: fileMounts(info),
    readOnly: config.readOnly,
    canWrite: !config.readOnly && config.allowFileWrite !== false,
    maxEditBytes: MAX_EDIT_BYTES,
  });
}));

filesRouter.get('/entries', wrap(async (req, res) => {
  const { mount } = await context(req);
  const dir = String(req.query.path || '');
  const { entries, truncated } = await listDir(req.docker, mount, dir);
  res.json({ path: dir, entries, truncated });
}));

filesRouter.get('/file', wrap(async (req, res) => {
  const { mount } = await context(req);
  const rel = String(req.query.path || '');
  const { content, size } = await readFile(req.docker, mount, rel, MAX_EDIT_BYTES);
  const binary = content.includes(0) || !isTextName(rel);
  res.json({
    path: rel,
    size,
    binary,
    readOnly: !mount.rw,
    content: binary ? null : content.toString('utf8'),
  });
}));

filesRouter.put('/file', wrap(async (req, res, next) => {
  try {
    guardWritable(req);
  } catch (e) {
    return next(e);
  }
  const { mount, info } = await context(req);
  const rel = String(req.body?.path || '');
  const text = req.body?.content;
  if (typeof text !== 'string') return res.status(400).json({ error: '缺少 content' });
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) return res.status(413).json({ error: '内容过大' });
  // The file itself may be read-only even when the mount is writable
  await writeFile(req.docker, mount, rel, Buffer.from(text, 'utf8'));
  audit({
    user: req.user,
    ip: clientIp(req),
    action: 'file-write',
    host: req.hostId,
    hostName: hosts.name(req.hostId),
    target: info.Id,
    targetName: containerName(info),
    ok: true,
    detail: `${mount.target}/${rel} (${Buffer.byteLength(text)} B)`,
  });
  res.json({ ok: true, bytes: Buffer.byteLength(text) });
}));

filesRouter.post('/upload', wrap(async (req, res, next) => {
  try {
    guardWritable(req);
  } catch (e) {
    return next(e);
  }
  const { mount, info } = await context(req);
  const dir = String(req.query.path || '');
  if (req.headers['content-type']?.includes('application/x-tar') || req.headers['content-type']?.includes('tar')) {
    // A tar stream (used by the "upload folder/file" flow implemented in the browser)
    await uploadArchive(req.docker, mount, dir, req, { overwrite: req.query.overwrite !== '0' });
    audit({
      user: req.user, ip: clientIp(req), action: 'file-upload', host: req.hostId, hostName: hosts.name(req.hostId),
      target: info.Id, targetName: containerName(info), ok: true, detail: `${mount.target}/${dir}`,
    });
    return res.json({ ok: true });
  }
  const name = String(req.query.name || '').split(/[\\/]/).pop();
  if (!name) return res.status(400).json({ error: '缺少文件名' });
  const data = await readBody(req, 64 * 1024 * 1024);
  await writeFile(req.docker, mount, `${dir ? `${dir}/` : ''}${name}`, data);
  audit({
    user: req.user, ip: clientIp(req), action: 'file-upload', host: req.hostId, hostName: hosts.name(req.hostId),
    target: info.Id, targetName: containerName(info), ok: true, detail: `${mount.target}/${dir}/${name} (${data.length} B)`,
  });
  res.json({ ok: true, bytes: data.length });
}));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('文件过大（上限 64 MB）'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

filesRouter.get('/download', wrap(async (req, res) => {
  const { mount } = await context(req);
  const rel = String(req.query.path || '');
  const { stream, name, type, release } = await downloadStream(req.docker, mount, rel);
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`);
  stream.on('error', () => res.destroy());
  res.on('close', release);
  stream.pipe(res);
}));

filesRouter.post('/mkdir', wrap(async (req, res, next) => {
  try {
    guardWritable(req);
  } catch (e) {
    return next(e);
  }
  const { mount, info } = await context(req);
  const rel = String(req.body?.path || '').replace(/\/+$/, '');
  if (!rel) return res.status(400).json({ error: '缺少目录名' });
  await mkdir(req.docker, mount, rel);
  audit({
    user: req.user, ip: clientIp(req), action: 'file-mkdir', host: req.hostId, hostName: hosts.name(req.hostId),
    target: info.Id, targetName: containerName(info), ok: true, detail: `${mount.target}/${rel}`,
  });
  res.json({ ok: true });
}));

filesRouter.post('/rename', wrap(async (req, res, next) => {
  try {
    guardWritable(req);
  } catch (e) {
    return next(e);
  }
  const { mount, info } = await context(req);
  const from = String(req.body?.from || '');
  const to = String(req.body?.to || '');
  if (!from || !to) return res.status(400).json({ error: '缺少路径' });
  await rename(req.docker, mount, from, to);
  audit({
    user: req.user, ip: clientIp(req), action: 'file-rename', host: req.hostId, hostName: hosts.name(req.hostId),
    target: info.Id, targetName: containerName(info), ok: true, detail: `${mount.target}: ${from} → ${to}`,
  });
  res.json({ ok: true });
}));

filesRouter.post('/chmod', wrap(async (req, res, next) => {
  try {
    guardWritable(req);
  } catch (e) {
    return next(e);
  }
  const { mount, info } = await context(req);
  const rel = String(req.body?.path || '');
  await chmod(req.docker, mount, rel, String(req.body?.mode || ''));
  audit({
    user: req.user, ip: clientIp(req), action: 'file-chmod', host: req.hostId, hostName: hosts.name(req.hostId),
    target: info.Id, targetName: containerName(info), ok: true, detail: `${mount.target}/${rel} → ${req.body?.mode}`,
  });
  res.json({ ok: true });
}));

filesRouter.delete('/path', wrap(async (req, res, next) => {
  try {
    guardWritable(req);
  } catch (e) {
    return next(e);
  }
  const { mount, info } = await context(req);
  const rel = String(req.query.path || '');
  if (!rel) return res.status(400).json({ error: '缺少路径' });
  const recursive = req.query.recursive === '1';
  await removePath(req.docker, mount, rel, { recursive });
  audit({
    user: req.user, ip: clientIp(req), action: 'file-delete', host: req.hostId, hostName: hosts.name(req.hostId),
    target: info.Id, targetName: containerName(info), ok: true, detail: `${mount.target}/${rel}${recursive ? ' (递归删除)' : ''}`,
  });
  res.json({ ok: true });
}));

/** File routes are mounted under the host router; map errors the same way as the rest of the API. */
export function fileErrorHandler(err, _req, res, next) {
  if (!err) return next();
  const { status, message } = dockerError(err);
  res.status(err.statusCode && err.statusCode >= 400 ? err.statusCode : status).json({ error: message });
}
