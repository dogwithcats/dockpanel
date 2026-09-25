import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { wsContainerPath, wsUrl } from '../lib/api';
import { formatBytes, formatPercent, formatRate } from '../lib/format';
import type { Stats } from '../lib/types';
import { Sparkline } from './Sparkline';

interface Sample extends Stats {
  rxRate: number;
  txRate: number;
  readRate: number;
  writeRate: number;
}

const HISTORY = 60;

export function StatsPanel({ hostId, containerId, running }: { hostId: string; containerId: string; running: boolean }) {
  const [samples, setSamples] = useState<Sample[]>([]);

  useEffect(() => {
    setSamples([]);
    if (!running) return;
    const ws = new WebSocket(wsUrl(wsContainerPath(hostId, containerId, 'stats')));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type !== 'stats') return;
      const s = msg.data as Stats;
      setSamples((prev) => {
        const last = prev[prev.length - 1];
        const dt = last ? Math.max(0.001, (s.time - last.time) / 1000) : 1;
        const rate = (a: number, b?: number) => (last && b !== undefined ? Math.max(0, (a - b) / dt) : 0);
        const next: Sample = {
          ...s,
          rxRate: rate(s.netRx, last?.netRx),
          txRate: rate(s.netTx, last?.netTx),
          readRate: rate(s.blkRead, last?.blkRead),
          writeRate: rate(s.blkWrite, last?.blkWrite),
        };
        return [...prev.slice(-(HISTORY - 1)), next];
      });
    };
    return () => ws.close();
  }, [hostId, containerId, running]);

  if (!running) {
    return (
      <div className="card empty" style={{ padding: '28px 20px' }}>
        <Activity size={24} />
        <h4>容器未运行</h4>
        <div>启动后将显示实时资源监控</div>
      </div>
    );
  }

  const cur = samples[samples.length - 1];
  const series = (k: keyof Sample) => samples.map((s) => s[k] as number);

  return (
    <div className="grid cols-4">
      <div className="card metric">
        <div className="top">
          <span className="label">CPU</span>
          <span className="sub">{cur ? `${cur.cpus} 核可用` : ''}</span>
        </div>
        <div className="value">{cur ? formatPercent(cur.cpuPercent) : '—'}</div>
        <div className="sub">100% = 1 个核心</div>
        <Sparkline data={series('cpuPercent')} color="var(--accent)" points={HISTORY} />
      </div>
      <div className="card metric">
        <div className="top">
          <span className="label">内存</span>
          <span className="sub">{cur ? formatPercent(cur.memPercent) : ''}</span>
        </div>
        <div className="value">{cur ? formatBytes(cur.memUsage) : '—'}</div>
        <div className="sub">上限 {cur ? formatBytes(cur.memLimit) : '—'}</div>
        <Sparkline data={series('memUsage')} color="var(--purple)" points={HISTORY} />
      </div>
      <div className="card metric">
        <div className="top">
          <span className="label">网络</span>
          <span className="sub">{cur ? `PIDs ${cur.pids}` : ''}</span>
        </div>
        <div className="value" style={{ fontSize: 17, marginTop: 8 }}>
          ↓ {cur ? formatRate(cur.rxRate) : '—'}
          <span className="dim" style={{ margin: '0 6px' }}>
            ·
          </span>
          ↑ {cur ? formatRate(cur.txRate) : '—'}
        </div>
        <div className="sub" style={{ marginTop: 3 }}>
          累计 ↓ {cur ? formatBytes(cur.netRx) : '—'} ↑ {cur ? formatBytes(cur.netTx) : '—'}
        </div>
        <Sparkline data={samples.map((s) => s.rxRate + s.txRate)} color="var(--green)" points={HISTORY} />
      </div>
      <div className="card metric">
        <div className="top">
          <span className="label">磁盘 I/O</span>
        </div>
        <div className="value" style={{ fontSize: 17, marginTop: 8 }}>
          R {cur ? formatRate(cur.readRate) : '—'}
          <span className="dim" style={{ margin: '0 6px' }}>
            ·
          </span>
          W {cur ? formatRate(cur.writeRate) : '—'}
        </div>
        <div className="sub" style={{ marginTop: 3 }}>
          累计 R {cur ? formatBytes(cur.blkRead) : '—'} W {cur ? formatBytes(cur.blkWrite) : '—'}
        </div>
        <Sparkline data={samples.map((s) => s.readRate + s.writeRate)} color="var(--yellow)" points={HISTORY} />
      </div>
    </div>
  );
}
