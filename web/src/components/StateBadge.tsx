import { exitCode, STATE_LABEL, stateGroup } from '../lib/format';
import type { ContainerSummary } from '../lib/types';

const TONE = {
  running: 'tone-green',
  paused: 'tone-yellow',
  failed: 'tone-red',
  stopped: 'tone-gray',
} as const;

export function StateBadge({ c, health }: { c: Pick<ContainerSummary, 'state' | 'status'>; health?: string }) {
  const g = stateGroup(c);
  let label = STATE_LABEL[c.state] ?? c.state;
  const code = c.state === 'exited' ? exitCode(c.status) : null;
  if (code !== null && code !== 0) label += ` (${code})`;
  const unhealthy = health === 'unhealthy' || /\(unhealthy\)/.test(c.status);
  const tone = unhealthy ? 'tone-red' : TONE[g];
  return (
    <span className={`badge ${tone} ${g === 'running' ? 'live' : ''}`} title={c.status}>
      <span className="dot" />
      {label}
      {unhealthy && ' · 不健康'}
    </span>
  );
}

export function stateColor(c: Pick<ContainerSummary, 'state' | 'status'>) {
  const g = stateGroup(c);
  return g === 'running' ? 'var(--green)' : g === 'paused' ? 'var(--yellow)' : g === 'failed' ? 'var(--red)' : 'var(--text-3)';
}
