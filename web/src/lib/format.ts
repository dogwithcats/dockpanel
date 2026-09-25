import type { ContainerState, ContainerSummary } from './types';

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`;
}

export const formatRate = (bytesPerSec: number) => `${formatBytes(bytesPerSec)}/s`;

export function formatPercent(v: number, digits = 1) {
  if (!Number.isFinite(v)) return '0%';
  return `${v.toFixed(v >= 100 ? 0 : digits)}%`;
}

export function timeAgo(ts: number | string): string {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!t || t < 0) return '-';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

export function formatDuration(from: number | string): string {
  const t = typeof from === 'string' ? Date.parse(from) : from;
  if (!t || t < 0) return '-';
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分钟`;
  return `${s} 秒`;
}

export function formatDate(ts: number | string): string {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!t || t < 0) return '-';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12);

/** "Exited (137) 3 hours ago" -> 137 */
export function exitCode(status: string): number | null {
  const m = /Exited \((-?\d+)\)/.exec(status);
  return m ? Number(m[1]) : null;
}

export type StateGroup = 'running' | 'stopped' | 'failed' | 'paused';

export function stateGroup(c: Pick<ContainerSummary, 'state' | 'status'>): StateGroup {
  if (c.state === 'running') return 'running';
  if (c.state === 'paused') return 'paused';
  if (c.state === 'dead' || c.state === 'restarting') return 'failed';
  if (c.state === 'exited') {
    const code = exitCode(c.status);
    // 0 = clean, 143/137 = SIGTERM/SIGKILL from `docker stop`
    return code === null || code === 0 || code === 143 || code === 137 ? 'stopped' : 'failed';
  }
  return 'stopped';
}

export const STATE_LABEL: Record<ContainerState, string> = {
  running: '运行中',
  paused: '已暂停',
  restarting: '重启中',
  removing: '删除中',
  exited: '已停止',
  created: '已创建',
  dead: '已失效',
};

export function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export const SENSITIVE_KEY = /pass|secret|token|key|pwd|credential|auth|private/i;
