export const PROTECTED_LABEL = 'dockpanel.protected';

export function containerName(c) {
  const n = c.Names?.[0] ?? c.Name ?? '';
  return n.replace(/^\//, '');
}

function dedupePorts(ports) {
  const seen = new Map();
  for (const p of ports || []) {
    const key = `${p.PublicPort ?? ''}:${p.PrivatePort}/${p.Type}`;
    if (!seen.has(key)) seen.set(key, { ip: p.IP, public: p.PublicPort ?? null, private: p.PrivatePort, type: p.Type });
  }
  return [...seen.values()].sort((a, b) => (a.private ?? 0) - (b.private ?? 0));
}

/** Compact representation of an item from GET /containers/json */
export function summarize(c, host) {
  const labels = c.Labels || {};
  return {
    host,
    id: c.Id,
    name: containerName(c),
    image: c.Image,
    imageId: c.ImageID,
    command: c.Command,
    created: c.Created * 1000,
    state: c.State,
    status: c.Status,
    ports: dedupePorts(c.Ports),
    networks: Object.keys(c.NetworkSettings?.Networks || {}),
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    protected: labels[PROTECTED_LABEL] === 'true',
  };
}

/** Turn a raw /containers/{id}/stats sample into display numbers. */
export function calcStats(s) {
  const cpu = s.cpu_stats || {};
  const pre = s.precpu_stats || {};
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const cpus = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  // The first streamed sample has no previous reading (precpu empty) – report 0 instead of a lifetime average.
  const cpuPercent = pre.system_cpu_usage && sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  const mem = s.memory_stats || {};
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? mem.stats?.cache ?? 0;
  const memUsage = Math.max(0, (mem.usage ?? 0) - cache);
  const memLimit = mem.limit ?? 0;

  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks || {})) {
    rx += n.rx_bytes || 0;
    tx += n.tx_bytes || 0;
  }

  let read = 0;
  let write = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive || []) {
    const op = (e.op || '').toLowerCase();
    if (op === 'read') read += e.value;
    else if (op === 'write') write += e.value;
  }

  return {
    time: Date.now(),
    cpuPercent,
    cpus,
    memUsage,
    memLimit,
    memPercent: memLimit ? (memUsage / memLimit) * 100 : 0,
    netRx: rx,
    netTx: tx,
    blkRead: read,
    blkWrite: write,
    pids: s.pids_stats?.current ?? 0,
  };
}

const NET_ERRORS = {
  ECONNREFUSED: '连接被拒绝（服务未启动或端口错误）',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ENOTFOUND: '无法解析主机名',
  EAI_AGAIN: '无法解析主机名',
  ECONNRESET: '连接被重置',
  EPIPE: '连接已断开',
  ENOENT: 'Docker socket 不存在（Docker 是否在运行？）',
  EACCES: '没有权限访问 Docker socket',
};

/** Convert a docker-modem error into { status, message } */
export function dockerError(err) {
  const code = err?.code || err?.errors?.[0]?.code;
  if (code && NET_ERRORS[code] && !err?.statusCode) {
    const target = err.address ? ` ${err.address}${err.port ? `:${err.port}` : ''}` : '';
    return { status: 502, message: `${NET_ERRORS[code]}${target ? `（${target.trim()}）` : ''}` };
  }
  const status = err?.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const message =
    err?.json?.message ||
    (typeof err?.json === 'string' ? err.json : null) ||
    err?.reason ||
    err?.message ||
    'Docker 请求失败';
  return { status, message: String(message).trim() };
}
