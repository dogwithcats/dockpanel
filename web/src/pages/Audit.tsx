import { CheckCircle2, RefreshCw, ScrollText, Search, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { api } from '../lib/api';
import { formatDate, timeAgo } from '../lib/format';
import { ACTION_LABEL, usePolling } from '../lib/hooks';
import type { AuditEntry, ContainerAction } from '../lib/types';

const EXTRA_LABEL: Record<string, string> = {
  exec: '进入终端',
  login: '登录',
  logout: '退出登录',
  'host-add': '添加服务器',
  'host-update': '修改服务器',
  'host-remove': '移除服务器',
};
const TONE: Record<string, string> = {
  start: 'tone-green',
  unpause: 'tone-green',
  stop: 'tone-yellow',
  pause: 'tone-yellow',
  restart: 'tone-blue',
  kill: 'tone-red',
  remove: 'tone-red',
  exec: 'tone-purple',
  login: 'tone-gray',
  logout: 'tone-gray',
  'host-add': 'tone-blue',
  'host-update': 'tone-blue',
  'host-remove': 'tone-red',
};

export function Audit() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);

  const load = usePolling(async () => {
    setLoading(true);
    try {
      setItems(await api.audit());
    } finally {
      setLoading(false);
    }
  }, 15000);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items || []).filter((e) => {
      if (onlyFailed && e.ok) return false;
      if (!s) return true;
      return [e.user, e.ip, e.action, e.hostName, e.targetName, e.target, e.detail, label(e.action)].join(' ').toLowerCase().includes(s);
    });
  }, [items, q, onlyFailed]);

  return (
    <>
      <Topbar
        crumbs={[{ label: '操作审计' }]}
        right={
          <button className="btn sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            刷新
          </button>
        }
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1>操作审计</h1>
            <p>记录登录、服务器变更、容器启停 / 删除以及终端会话，持久化在 data/audit.log。</p>
          </div>
        </div>
        <div className="card">
          <div className="toolbar">
            <div className="input-icon" style={{ width: 300 }}>
              <Search size={15} />
              <input className="input" placeholder="搜索用户、容器、操作、IP…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <label className="switch">
              <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
              <span className="track" />
              只看失败
            </label>
            <span className="spacer" />
            <span className="dim" style={{ fontSize: 12 }}>
              {visible.length} 条记录
            </span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 180 }}>时间</th>
                  <th>操作</th>
                  <th>服务器</th>
                  <th>对象</th>
                  <th>结果</th>
                  <th>用户</th>
                  <th>来源 IP</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {items && visible.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty">
                        <ScrollText size={28} />
                        <h4>暂无记录</h4>
                      </div>
                    </td>
                  </tr>
                )}
                {visible.map((e, i) => (
                  <tr key={`${e.time}-${i}`}>
                    <td className="nowrap">
                      <div>{formatDate(e.time)}</div>
                      <div className="dim" style={{ fontSize: 11.5 }}>
                        {timeAgo(e.time)}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${TONE[e.action] || 'tone-gray'}`}>{label(e.action)}</span>
                    </td>
                    <td className="nowrap">{e.hostName || <span className="dim">—</span>}</td>
                    <td>
                      {e.target && e.host ? (
                        <Link to={`/hosts/${e.host}/containers/${e.target}`} className="mono">
                          {e.targetName || e.target.slice(0, 12)}
                        </Link>
                      ) : e.target ? (
                        <span className="mono">{e.targetName || e.target.slice(0, 12)}</span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td>
                      {e.ok ? (
                        <span className="row" style={{ color: 'var(--green)', gap: 5 }}>
                          <CheckCircle2 size={14} /> 成功
                        </span>
                      ) : (
                        <span className="row" style={{ color: 'var(--red)', gap: 5 }}>
                          <XCircle size={14} /> 失败
                        </span>
                      )}
                    </td>
                    <td>{e.user || '—'}</td>
                    <td className="mono dim">{e.ip || '—'}</td>
                    <td className="muted" style={{ maxWidth: 380, fontSize: 12.5 }}>
                      {e.detail || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function label(action: string) {
  return ACTION_LABEL[action as ContainerAction] || EXTRA_LABEL[action] || action;
}
