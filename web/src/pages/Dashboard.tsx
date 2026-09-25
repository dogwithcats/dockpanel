import { AlertTriangle, Boxes, CheckCircle2, ChevronRight, Layers, RefreshCw, Server, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HostTag, hostDotColor, Topbar } from '../components/Layout';
import { StateBadge, stateColor } from '../components/StateBadge';
import { api } from '../lib/api';
import { formatBytes, stateGroup, timeAgo } from '../lib/format';
import { usePolling, useHosts } from '../lib/hooks';
import type { ContainersResponse, ContainerSummary } from '../lib/types';

export function Dashboard() {
  const { hosts, multi, refresh: refreshHosts } = useHosts();
  const [data, setData] = useState<ContainersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const load = usePolling(async () => {
    setLoading(true);
    try {
      setData(await api.containers());
    } finally {
      setLoading(false);
    }
  }, 10000);

  const list = data?.items;
  const groups = useMemo(() => {
    const g = { running: 0, stopped: 0, failed: 0, paused: 0 };
    for (const c of list || []) g[stateGroup(c)]++;
    return g;
  }, [list]);

  const attention = useMemo(
    () => (list || []).filter((c) => stateGroup(c) === 'failed' || /unhealthy/.test(c.status)),
    [list],
  );
  const recent = useMemo(() => [...(list || [])].sort((a, b) => b.created - a.created).slice(0, 6), [list]);
  const projects = useMemo(() => {
    const m = new Map<string, { host: string; name: string; total: number; running: number }>();
    for (const c of list || []) {
      if (!c.project) continue;
      const k = `${c.host}/${c.project}`;
      const p = m.get(k) || { host: c.host, name: c.project, total: 0, running: 0 };
      p.total++;
      if (c.state === 'running') p.running++;
      m.set(k, p);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [list]);

  const online = (hosts || []).filter((h) => h.status.state === 'online');
  const images = online.reduce((a, h) => a + (h.status.info?.images ?? 0), 0);
  const total = list?.length ?? 0;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  const open = (c: ContainerSummary, tab = '') => navigate(`/hosts/${c.host}/containers/${c.id}${tab}`);

  return (
    <>
      <Topbar
        crumbs={[{ label: '概览' }]}
        right={
          <button
            className="btn sm"
            onClick={() => {
              load();
              refreshHosts();
            }}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            刷新
          </button>
        }
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1>概览</h1>
            <p>
              {hosts ? `${hosts.length} 台服务器，${online.length} 台在线` : '正在连接…'}
              {data && data.errors.length > 0 && ` · ${data.errors.length} 台无法获取容器`}
            </p>
          </div>
        </div>

        {data?.errors.map((e) => (
          <div key={e.host} className="banner warn">
            <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
            <div>
              <b>{e.name}</b>：{e.error}
            </div>
          </div>
        ))}

        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <div className="card stat">
            <div className="label">
              <span className="ico tone-blue">
                <Server size={14} />
              </span>
              服务器
            </div>
            <div className="value">
              {hosts ? online.length : '—'}
              <small>/ {hosts?.length ?? 0} 在线</small>
            </div>
            <div className="foot">
              {(hosts || []).map((h) => (
                <span key={h.id} className="row" style={{ gap: 5 }}>
                  <span className="host-dot" style={{ background: hostDotColor(h), width: 6, height: 6 }} />
                  {h.name}
                </span>
              ))}
            </div>
          </div>

          <div className="card stat">
            <div className="label">
              <span className="ico tone-green">
                <Boxes size={14} />
              </span>
              容器
            </div>
            <div className="value">
              {list ? groups.running : '—'}
              <small>/ {total} 运行中</small>
            </div>
            <div className="bar" style={{ marginTop: 12 }}>
              <span style={{ width: `${pct(groups.running)}%`, background: 'var(--green)' }} />
              <span style={{ width: `${pct(groups.paused)}%`, background: 'var(--yellow)' }} />
              <span style={{ width: `${pct(groups.failed)}%`, background: 'var(--red)' }} />
            </div>
            <div className="foot">
              <span>停止 {groups.stopped}</span>
              {groups.paused > 0 && <span>暂停 {groups.paused}</span>}
            </div>
          </div>

          <div className="card stat">
            <div className="label">
              <span className={`ico ${attention.length ? 'tone-red' : 'tone-gray'}`}>
                <AlertTriangle size={14} />
              </span>
              需要关注
            </div>
            <div className="value" style={{ color: attention.length ? 'var(--red)' : undefined }}>
              {list ? attention.length : '—'}
            </div>
            <div className="foot">异常退出 / 不健康 / 反复重启</div>
          </div>

          <div className="card stat">
            <div className="label">
              <span className="ico tone-purple">
                <Layers size={14} />
              </span>
              镜像
            </div>
            <div className="value">{hosts ? images : '—'}</div>
            <div className="foot">{online.length > 1 ? `分布在 ${online.length} 台服务器` : ''}</div>
          </div>
        </div>

        <div className="grid main-side">
          <div className="grid" style={{ alignContent: 'start' }}>
            <div className="card">
              <div className="card-head">
                <AlertTriangle size={15} className="dim" />
                <h3>需要关注</h3>
                <span className="hint">{attention.length ? `${attention.length} 个容器` : ''}</span>
              </div>
              {attention.length === 0 ? (
                <div className="empty" style={{ padding: '34px 20px' }}>
                  <CheckCircle2 size={28} color="var(--green)" style={{ opacity: 1 }} />
                  <h4>一切正常</h4>
                  <div>没有异常退出或不健康的容器</div>
                </div>
              ) : (
                <ContainerMiniList items={attention} multi={multi} onOpen={(c) => open(c, '/logs')} hint="查看日志" />
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <Boxes size={15} className="dim" />
                <h3>最近创建</h3>
                <span className="spacer" />
                <Link to="/containers" className="btn ghost sm">
                  全部容器 <ChevronRight size={14} />
                </Link>
              </div>
              {list && recent.length === 0 ? (
                <div className="empty">
                  <Square size={26} />
                  <h4>还没有容器</h4>
                </div>
              ) : (
                <ContainerMiniList items={recent} multi={multi} onOpen={(c) => open(c)} />
              )}
            </div>
          </div>

          <div className="grid" style={{ alignContent: 'start' }}>
            <div className="card">
              <div className="card-head">
                <Server size={15} className="dim" />
                <h3>服务器</h3>
                <span className="spacer" />
                <Link to="/hosts" className="btn ghost sm">
                  管理 <ChevronRight size={14} />
                </Link>
              </div>
              <div style={{ padding: '6px 8px' }}>
                {hosts?.length === 0 && (
                  <div className="empty" style={{ padding: '20px 10px' }}>
                    <Link to="/hosts" className="btn primary sm">
                      添加服务器
                    </Link>
                  </div>
                )}
                {hosts?.map((h) => {
                  const i = h.status.info;
                  return (
                    <Link
                      key={h.id}
                      to={`/containers?host=${h.id}`}
                      className="row"
                      style={{ padding: '9px 8px', borderRadius: 6, color: 'var(--text)', alignItems: 'flex-start' }}
                    >
                      <span className="host-dot" style={{ background: hostDotColor(h), marginTop: 6 }} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="row" style={{ fontWeight: 550 }}>
                          <span className="truncate">{h.name}</span>
                          <span className="spacer" />
                          {h.status.state === 'online' && i && (
                            <span className="dim mono" style={{ fontWeight: 400, fontSize: 12 }}>
                              {i.running}/{i.containers}
                            </span>
                          )}
                        </span>
                        <span className="dim truncate" style={{ display: 'block', fontSize: 11.5, color: h.status.state === 'offline' ? 'var(--red)' : undefined }}>
                          {h.status.state === 'online' && i
                            ? `${i.cpus} 核 · ${formatBytes(i.memTotal, 0)} · Docker ${i.serverVersion} · ${h.status.latency}ms`
                            : h.status.error || '检测中…'}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <Layers size={15} className="dim" />
                <h3>Compose 项目</h3>
                <span className="hint">{projects.length || ''}</span>
              </div>
              {projects.length === 0 ? (
                <div className="empty" style={{ padding: '26px 20px' }}>
                  未检测到 docker compose 项目
                </div>
              ) : (
                <div style={{ padding: '6px 8px' }}>
                  {projects.map((p) => (
                    <Link
                      key={`${p.host}/${p.name}`}
                      to={`/containers?host=${p.host}&project=${encodeURIComponent(p.name)}`}
                      className="row"
                      style={{ padding: '8px 8px', borderRadius: 6, color: 'var(--text)' }}
                    >
                      <span
                        className="status-dot"
                        style={{
                          background: p.running === p.total ? 'var(--green)' : p.running === 0 ? 'var(--text-3)' : 'var(--yellow)',
                        }}
                      />
                      <span className="grow truncate" style={{ fontWeight: 500 }}>
                        {p.name}
                      </span>
                      {multi && <HostTag id={p.host} link={false} />}
                      <span className="dim mono">
                        {p.running}/{p.total}
                      </span>
                      <ChevronRight size={14} className="dim" />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ContainerMiniList({
  items,
  onOpen,
  hint,
  multi,
}: {
  items: ContainerSummary[];
  onOpen: (c: ContainerSummary) => void;
  hint?: string;
  multi: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <tbody>
          {items.map((c) => (
            <tr key={`${c.host}/${c.id}`} className="clickable" onClick={() => onOpen(c)}>
              <td style={{ width: 20, paddingRight: 0 }}>
                <span className="status-dot" style={{ background: stateColor(c), display: 'block' }} />
              </td>
              <td>
                <div className="name-cell">
                  <span className="name">{c.name}</span>
                  <span className="sub truncate" style={{ maxWidth: 360 }}>
                    {c.image}
                  </span>
                </div>
              </td>
              {multi && (
                <td>
                  <HostTag id={c.host} />
                </td>
              )}
              <td>
                <StateBadge c={c} />
              </td>
              <td className="dim nowrap" style={{ fontSize: 12 }}>
                {timeAgo(c.created)}
              </td>
              <td className="col-actions dim" style={{ fontSize: 12 }}>
                {hint} <ChevronRight size={14} style={{ verticalAlign: -3 }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
