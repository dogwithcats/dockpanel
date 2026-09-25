import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  Filter,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hostPath, withBase, wsContainerPath, wsUrl } from '../lib/api';
import { stripAnsi } from '../lib/format';
import { safeFit, XTERM_BASE } from './xterm';

type Status = 'connecting' | 'streaming' | 'ended' | 'error';
interface Line {
  err: boolean;
  text: string;
}

const MAX_LINES = 50_000;
const TAILS = ['100', '500', '1000', '5000', 'all'];
const SINCE: [string, string][] = [
  ['0', '不限时间'],
  ['300', '最近 5 分钟'],
  ['1800', '最近 30 分钟'],
  ['3600', '最近 1 小时'],
  ['21600', '最近 6 小时'],
  ['86400', '最近 24 小时'],
];

const DIM = '\x1b[38;5;244m';
const ERR = '\x1b[38;2;255;130;125m';
const RESET = '\x1b[0m';
const TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z? /;

function render(line: Line, timestamps: boolean) {
  let text = line.text;
  let prefix = '';
  if (timestamps) {
    const m = TS_RE.exec(text);
    if (m) {
      prefix = `${DIM}${m[1]} ${m[2]}${(m[3] || '').slice(0, 4)}${RESET} `;
      text = text.slice(m[0].length);
    }
  }
  // Tint stderr lines that don't bring their own colors
  if (line.err && !text.includes('\x1b[')) text = `${ERR}${text}${RESET}`;
  return prefix + text;
}

export function LogViewer({ hostId, containerId, active }: { hostId: string; containerId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const lines = useRef<Line[]>([]);
  const partial = useRef<{ o: string; e: string }>({ o: '', e: '' });

  const [tail, setTail] = useState('500');
  const [since, setSince] = useState('0');
  const [timestamps, setTimestamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [lineCount, setLineCount] = useState(0);
  const [matches, setMatches] = useState<{ index: number; count: number } | null>(null);
  const [session, setSession] = useState(0);

  // Mirror state into refs for the streaming callback
  const opts = useRef({ timestamps, follow, query, filterMode });
  opts.current = { timestamps, follow, query, filterMode };

  const matchesFilter = (l: Line) => {
    const { query: q, filterMode: f } = opts.current;
    return !f || !q || stripAnsi(l.text).toLowerCase().includes(q.toLowerCase());
  };

  /* ---------- terminal instance (once) */
  useEffect(() => {
    const t = new Terminal({
      ...XTERM_BASE,
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      scrollback: MAX_LINES,
    });
    const f = new FitAddon();
    const s = new SearchAddon({ highlightLimit: 2000 });
    t.loadAddon(f);
    t.loadAddon(s);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    t.open(hostRef.current!);
    // Hide the cursor entirely – this is a read-only viewer
    t.write('\x1b[?25l');
    s.onDidChangeResults((r) => setMatches(r ? { index: r.resultIndex, count: r.resultCount } : null));
    term.current = t;
    fit.current = f;
    search.current = s;
    safeFit(hostRef.current, f);
    const ro = new ResizeObserver(() => safeFit(hostRef.current, f));
    ro.observe(hostRef.current!);
    return () => {
      ro.disconnect();
      t.dispose();
    };
  }, []);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fit.current && safeFit(hostRef.current, fit.current));
  }, [active]);

  const repaint = useCallback(() => {
    const t = term.current;
    if (!t) return;
    t.reset();
    t.write('\x1b[?25l');
    const out = lines.current.filter(matchesFilter).map((l) => render(l, opts.current.timestamps));
    // write in chunks to keep the UI responsive
    for (let i = 0; i < out.length; i += 2000) t.write(out.slice(i, i + 2000).join('\n') + '\n');
    if (opts.current.follow) t.scrollToBottom();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- stream */
  useEffect(() => {
    const t = term.current!;
    lines.current = [];
    partial.current = { o: '', e: '' };
    setLineCount(0);
    t.reset();
    t.write('\x1b[?25l');
    setStatus('connecting');
    setErrorMsg('');

    const q = new URLSearchParams({ tail, since, timestamps: timestamps ? '1' : '0' });
    const ws = new WebSocket(wsUrl(`${wsContainerPath(hostId, containerId, 'logs')}?${q}`));
    let closedByUs = false;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === 'meta') setStatus('streaming');
      else if (msg.type === 'log') {
        const add: Line[] = [];
        for (const [kind, chunk] of msg.chunks as [string, string][]) {
          const k = kind === 'e' ? 'e' : 'o';
          const parts = (partial.current[k] + chunk).split('\n');
          partial.current[k] = parts.pop() ?? '';
          for (const p of parts) add.push({ err: k === 'e', text: p.replace(/\r$/, '') });
        }
        if (!add.length) return;
        lines.current.push(...add);
        if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
        const shown = add.filter(matchesFilter);
        if (shown.length) {
          t.write(shown.map((l) => render(l, opts.current.timestamps)).join('\n') + '\n');
          if (opts.current.follow) t.scrollToBottom();
        }
        setLineCount(lines.current.length);
      } else if (msg.type === 'end') {
        setStatus('ended');
      } else if (msg.type === 'error') {
        setStatus('error');
        setErrorMsg(msg.message);
      }
    };
    ws.onclose = () => {
      if (!closedByUs) setStatus((s) => (s === 'error' ? s : 'ended'));
    };
    ws.onerror = () => {
      setStatus('error');
      setErrorMsg('WebSocket 连接失败');
    };
    return () => {
      closedByUs = true;
      ws.close();
    };
  }, [hostId, containerId, tail, since, timestamps, session]);

  /* ---------- filter / search */
  useEffect(() => {
    const id = setTimeout(() => {
      if (filterMode) repaint();
      const s = search.current;
      if (!s) return;
      if (query && !filterMode) {
        s.findPrevious(query, {
          caseSensitive: false,
          decorations: {
            matchBackground: '#5a4a1a',
            activeMatchBackground: '#eaa53c',
            matchOverviewRuler: '#eaa53c',
            activeMatchColorOverviewRuler: '#ffffff',
          },
        });
      } else {
        s.clearDecorations();
        setMatches(null);
      }
    }, 200);
    return () => clearTimeout(id);
  }, [query, filterMode, repaint]);

  // Leaving filter mode must show every line again
  const prevFilter = useRef(filterMode);
  useEffect(() => {
    if (prevFilter.current && !filterMode) repaint();
    prevFilter.current = filterMode;
  }, [filterMode, repaint]);

  const find = (dir: 1 | -1) => {
    const s = search.current;
    if (!s || !query) return;
    const o = {
      caseSensitive: false,
      decorations: {
        matchBackground: '#5a4a1a',
        activeMatchBackground: '#eaa53c',
        matchOverviewRuler: '#eaa53c',
        activeMatchColorOverviewRuler: '#ffffff',
      },
    };
    if (dir === 1) s.findNext(query, o);
    else s.findPrevious(query, o);
  };

  const download = () => {
    const q = new URLSearchParams({ tail: tail === 'all' ? 'all' : tail, timestamps: timestamps ? '1' : '0' });
    window.open(withBase(`${hostPath(hostId)}/containers/${encodeURIComponent(containerId)}/logs/download?${q}`), '_blank');
  };

  const statusView = {
    connecting: { color: 'var(--yellow)', text: '连接中' },
    streaming: { color: 'var(--green)', text: '实时' },
    ended: { color: '#6f7a8a', text: '已结束' },
    error: { color: 'var(--red)', text: '错误' },
  }[status];

  return (
    <div className="console">
      <div className="console-bar">
        <select className="select sm" value={tail} onChange={(e) => setTail(e.target.value)} title="初始加载行数">
          {TAILS.map((t) => (
            <option key={t} value={t}>
              {t === 'all' ? '全部日志' : `最后 ${t} 行`}
            </option>
          ))}
        </select>
        <select className="select sm" value={since} onChange={(e) => setSince(e.target.value)}>
          {SINCE.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <label className="switch">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          <span className="track" />
          时间戳
        </label>

        <span className="spacer" />

        <div className="input-icon" style={{ width: 240 }}>
          <Search size={14} />
          <input
            className="input sm"
            placeholder={filterMode ? '过滤日志行…' : '搜索并高亮…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {query && (
            <button className="icon-btn sm clear" style={{ width: 22, height: 22 }} onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>
        {!filterMode && query && (
          <>
            <span className="dim mono" style={{ fontSize: 11.5, minWidth: 44, textAlign: 'center' }}>
              {matches ? (matches.count ? `${matches.index + 1}/${matches.count}` : '0/0') : ''}
            </span>
            <button className="icon-btn sm" title="上一个 (Shift+Enter)" onClick={() => find(-1)}>
              <ChevronUp size={15} />
            </button>
            <button className="icon-btn sm" title="下一个 (Enter)" onClick={() => find(1)}>
              <ChevronDown size={15} />
            </button>
          </>
        )}
        <button
          className={`icon-btn sm ${filterMode ? 'active' : ''}`}
          title={filterMode ? '当前：只显示匹配行（点击切换为高亮模式）' : '当前：高亮匹配（点击切换为只显示匹配行）'}
          onClick={() => setFilterMode((f) => !f)}
        >
          <Filter size={14} />
        </button>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <button
          className={`icon-btn sm ${follow ? 'active' : ''}`}
          title={follow ? '自动滚动：开' : '自动滚动：关'}
          onClick={() => {
            setFollow((f) => !f);
            if (!follow) term.current?.scrollToBottom();
          }}
        >
          {follow ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="icon-btn sm" title="滚动到底部" onClick={() => term.current?.scrollToBottom()}>
          <ArrowDownToLine size={14} />
        </button>
        <button
          className="icon-btn sm"
          title="清屏"
          onClick={() => {
            lines.current = [];
            setLineCount(0);
            term.current?.reset();
            term.current?.write('\x1b[?25l');
          }}
        >
          <Eraser size={14} />
        </button>
        <button className="icon-btn sm" title="重新连接" onClick={() => setSession((s) => s + 1)}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" title="下载日志" onClick={download}>
          <Download size={14} />
        </button>
      </div>

      <div className="console-body">
        <div ref={hostRef} style={{ height: '100%' }} />
        {status === 'error' && (
          <div className="console-overlay">
            <div>
              <h4>日志加载失败</h4>
              <div>{errorMsg}</div>
              <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setSession((s) => s + 1)}>
                <RefreshCw size={13} /> 重试
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="console-foot">
        <span className="conn">
          <span className="status-dot" style={{ background: statusView.color }} />
          {statusView.text}
        </span>
        <span>{lineCount.toLocaleString()} 行</span>
        {filterMode && query && <span style={{ color: 'var(--yellow)' }}>过滤中：“{query}”</span>}
        <span className="spacer" />
        {!follow && <span style={{ color: 'var(--yellow)' }}>自动滚动已暂停</span>}
        <span>stderr 以红色显示</span>
      </div>
    </div>
  );
}
