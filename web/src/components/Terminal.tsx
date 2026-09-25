import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Eraser, Maximize2, Minimize2, Plug, PlugZap, SquareTerminal, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { wsContainerPath, wsUrl } from '../lib/api';
import { safeFit, XTERM_BASE } from './xterm';

type Status = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

const SHELLS: [string, string][] = [
  ['auto', '自动 (bash → sh)'],
  ['/bin/bash', '/bin/bash'],
  ['/bin/sh', '/bin/sh'],
  ['/bin/ash', '/bin/ash'],
  ['/bin/zsh', '/bin/zsh'],
];

export function ExecTerminal({
  hostId,
  containerId,
  containerName,
  running,
  active,
}: {
  hostId: string;
  containerId: string;
  containerName: string;
  running: boolean;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);

  const [shell, setShell] = useState(() => localStorage.getItem('dp-shell') || 'auto');
  const [user, setUser] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  const [fullscreen, setFullscreen] = useState(false);

  /* ---------- terminal instance */
  useEffect(() => {
    const t = new Terminal({
      ...XTERM_BASE,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      macOptionIsMeta: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    t.open(hostRef.current!);
    term.current = t;
    fit.current = f;

    const enc = new TextEncoder();
    t.onData((data) => {
      const s = ws.current;
      if (s?.readyState === WebSocket.OPEN) s.send(enc.encode(data));
    });
    t.onResize(({ cols, rows }) => {
      setSize({ cols, rows });
      const s = ws.current;
      if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    safeFit(hostRef.current, f);
    const ro = new ResizeObserver(() => safeFit(hostRef.current, f));
    ro.observe(hostRef.current!);
    return () => {
      ro.disconnect();
      ws.current?.close();
      t.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (fit.current) safeFit(hostRef.current, fit.current);
      term.current?.focus();
    });
  }, [active, fullscreen]);

  const connect = () => {
    const t = term.current;
    if (!t || !running) return;
    ws.current?.close();
    if (fit.current) safeFit(hostRef.current, fit.current);
    t.reset();
    setStatus('connecting');
    setMessage('');
    t.write(`\x1b[38;5;244m正在连接 ${containerName} …\x1b[0m\r\n`);

    const q = new URLSearchParams({ shell, cols: String(t.cols), rows: String(t.rows) });
    if (user.trim()) q.set('user', user.trim());
    const s = new WebSocket(wsUrl(`${wsContainerPath(hostId, containerId, 'exec')}?${q}`));
    s.binaryType = 'arraybuffer';
    ws.current = s;

    s.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        t.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') {
        setStatus('connected');
        t.reset();
        t.focus();
        s.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
      } else if (msg.type === 'exit') {
        setStatus('closed');
        setMessage(msg.code === null ? '会话已结束' : `进程已退出（exit ${msg.code}）`);
        t.write(`\r\n\x1b[38;5;244m[会话已结束${msg.code !== null ? `，exit ${msg.code}` : ''}]\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        setStatus('error');
        setMessage(msg.message);
        t.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      }
    };
    s.onclose = () => {
      if (ws.current !== s) return;
      setStatus((st) => (st === 'connected' || st === 'connecting' ? 'closed' : st));
    };
    s.onerror = () => {
      setStatus('error');
      setMessage('WebSocket 连接失败');
    };
  };

  const disconnect = () => {
    ws.current?.close();
    ws.current = null;
    setStatus('closed');
    setMessage('已断开连接');
  };

  // Auto connect the first time the tab is opened on a running container
  const autoConnected = useRef(false);
  useEffect(() => {
    if (active && running && !autoConnected.current) {
      autoConnected.current = true;
      setTimeout(connect, 30);
    }
    if (!running && ws.current) disconnect();
  }, [active, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusView = {
    idle: { color: '#6f7a8a', text: '未连接' },
    connecting: { color: 'var(--yellow)', text: '连接中' },
    connected: { color: 'var(--green)', text: '已连接' },
    closed: { color: '#6f7a8a', text: '已断开' },
    error: { color: 'var(--red)', text: '错误' },
  }[status];

  const busy = status === 'connecting' || status === 'connected';

  return (
    <div
      ref={wrapRef}
      className="console"
      style={fullscreen ? { position: 'fixed', inset: 0, margin: 0, zIndex: 50, borderRadius: 0 } : undefined}
    >
      <div className="console-bar">
        <SquareTerminal size={15} style={{ color: '#7a8596', marginLeft: 2 }} />
        <select
          className="select sm"
          value={shell}
          disabled={busy}
          onChange={(e) => {
            setShell(e.target.value);
            localStorage.setItem('dp-shell', e.target.value);
          }}
        >
          {SHELLS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input
          className="input sm"
          style={{ width: 150 }}
          placeholder="用户（默认容器用户）"
          value={user}
          disabled={busy}
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && connect()}
        />
        {busy ? (
          <button className="btn sm" onClick={disconnect}>
            <Unplug size={14} /> 断开
          </button>
        ) : (
          <button className="btn sm primary" onClick={connect} disabled={!running}>
            {status === 'idle' ? <Plug size={14} /> : <PlugZap size={14} />}
            {status === 'idle' ? '连接' : '重新连接'}
          </button>
        )}
        <span className="spacer" />
        <button className="icon-btn sm" title="清屏" onClick={() => term.current?.clear()}>
          <Eraser size={14} />
        </button>
        <button className="icon-btn sm" title={fullscreen ? '退出全屏' : '全屏'} onClick={() => setFullscreen((f) => !f)}>
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>

      <div className="console-body">
        <div ref={hostRef} style={{ height: '100%' }} />
        {!running && (
          <div className="console-overlay">
            <div>
              <SquareTerminal size={30} />
              <h4>容器未运行</h4>
              <div>启动容器后才能进入终端</div>
            </div>
          </div>
        )}
        {running && (status === 'closed' || status === 'error') && (
          <div className="console-overlay" style={{ background: 'transparent', placeItems: 'end center', paddingBottom: 24, pointerEvents: 'none' }}>
            <button className="btn primary" style={{ pointerEvents: 'auto' }} onClick={connect}>
              <PlugZap size={15} /> 重新连接
            </button>
          </div>
        )}
      </div>

      <div className="console-foot">
        <span className="conn">
          <span className="status-dot" style={{ background: statusView.color }} />
          {statusView.text}
        </span>
        {message && <span>{message}</span>}
        <span className="spacer" />
        {size.cols > 0 && (
          <span>
            {size.cols}×{size.rows}
          </span>
        )}
        <span>会话已记录到审计日志</span>
      </div>
    </div>
  );
}
