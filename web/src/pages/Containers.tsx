import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Copy,
  FileText,
  Layers,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Shield,
  Skull,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFeedback } from '../components/Feedback';
import { HostTag, hostDotColor, Topbar } from '../components/Layout';
import { MenuButton } from '../components/Menu';
import { StateBadge } from '../components/StateBadge';
import { api } from '../lib/api';
import { copyText, formatDate, shortId, stateGroup, timeAgo, type StateGroup } from '../lib/format';
import { busyKey, useContainerActions, useHosts, usePolling, useSession } from '../lib/hooks';
import type { ContainerAction, ContainerSummary, ContainersResponse } from '../lib/types';

type Filter = 'all' | StateGroup;
type SortKey = 'name' | 'created' | 'state';
type GroupBy = 'host' | 'project' | 'none';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'stopped', label: '已停止' },
  { key: 'failed', label: '异常' },
  { key: 'paused', label: '已暂停' },
];

const STATE_ORDER: Record<StateGroup, number> = { failed: 0, running: 1, paused: 2, stopped: 3 };

export function Containers() {
  const { me } = useSession();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { byId, multi, hosts } = useHosts();
  const [data, setData] = useState<ContainersResponse | null>(null);
  const list = data?.items ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupPref, setGroupPref] = useState<GroupBy | null>(() => localStorage.getItem('dp-groupby') as GroupBy | null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });

  const filter = (params.get('state') as Filter) || 'all';
  const project = params.get('project');
  const hostFilter = params.get('host');
  // Group by server by default when showing several servers, otherwise by compose project
  const groupBy: GroupBy = groupPref ?? (multi && !hostFilter ? 'host' : 'project');
  const effectiveGroup: GroupBy = groupBy === 'host' && hostFilter ? 'project' : groupBy;
  const showHostCol = multi && !hostFilter && effectiveGroup !== 'host';

  const load = usePolling(async () => {
    setLoading(true);
    try {
      const d = await api.containers(hostFilter || undefined);
      setData(d);
      setError('');
      const keys = new Set(d.items.map(busyKey));
      setSelected((s) => new Set([...s].filter((k) => keys.has(k))));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, 5000, [hostFilter]);

  const refresh = useCallback(() => void load(), [load]);
  const { run, busy } = useContainerActions(refresh);

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, running: 0, stopped: 0, failed: 0, paused: 0 };
    for (const x of list || []) {
      if (project && x.project !== project) continue;
      c.all++;
      c[stateGroup(x)]++;
    }
    return c;
  }, [list, project]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (list || []).filter((c) => {
      if (project && c.project !== project) return false;
      if (filter !== 'all' && stateGroup(c) !== filter) return false;
      if (!q) return true;
      return [c.name, c.image, c.id, c.project || '', c.service || '', byId[c.host]?.name || '', ...c.ports.map((p) => String(p.public ?? p.private))]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
    items.sort((a, b) => {
      let d = 0;
      if (sort.key === 'name') d = a.name.localeCompare(b.name);
      else if (sort.key === 'created') d = a.created - b.created;
      else d = STATE_ORDER[stateGroup(a)] - STATE_ORDER[stateGroup(b)] || a.name.localeCompare(b.name);
      return d * sort.dir;
    });
    return items;
  }, [list, query, filter, project, sort, byId]);

  const sections = useMemo(() => {
    if (effectiveGroup === 'none') return [{ key: '', label: '', host: '', items: visible }];
    const m = new Map<string, { key: string; label: string; host: string; items: ContainerSummary[] }>();
    for (const c of visible) {
      const k = effectiveGroup === 'host' ? c.host : `${c.host}/${c.project || ''}`;
      if (!m.has(k)) {
        m.set(k, {
          key: k,
          host: c.host,
          label: effectiveGroup === 'host' ? byId[c.host]?.name ?? c.host : c.project || '',
          items: [],
        });
      }
      m.get(k)!.items.push(c);
    }
    const hostOrder = (id: string) => (hosts || []).findIndex((h) => h.id === id);
    return [...m.values()].sort((a, b) => {
      if (effectiveGroup === 'host') return hostOrder(a.host) - hostOrder(b.host);
      // Named projects first, standalone containers last; group by host inside
      return hostOrder(a.host) - hostOrder(b.host) || (a.label === '' ? 1 : b.label === '' ? -1 : a.label.localeCompare(b.label));
    });
  }, [visible, effectiveGroup, byId, hosts]);

  const selectedItems = (list || []).filter((c) => selected.has(busyKey(c)));
  const allChecked = visible.length > 0 && visible.every((c) => selected.has(busyKey(c)));
  const someChecked = visible.some((c) => selected.has(busyKey(c)));

  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allChecked) visible.forEach((c) => n.delete(busyKey(c)));
      else visible.forEach((c) => n.add(busyKey(c)));
      return n;
    });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const bulk = async (action: ContainerAction) => {
    const ok = await run(action, selectedItems);
    if (ok && action === 'remove') setSelected(new Set());
  };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'created' ? -1 : 1 }));
  const SortIcon = ({ k }: { k: SortKey }) =>
    sort.key === k ? sort.dir === 1 ? <ArrowUp size={12} style={{ verticalAlign: -1 }} /> : <ArrowDown size={12} style={{ verticalAlign: -1 }} /> : null;

  const canMutate = !me.readOnly;
  const cols = (canMutate ? 7 : 6) + (showHostCol ? 1 : 0);
  const hostName = hostFilter ? byId[hostFilter]?.name ?? hostFilter : null;

  return (
    <>
      <Topbar
        crumbs={hostName ? [{ label: '容器', to: '/containers' }, { label: hostName }] : [{ label: '容器' }]}
        right={
          <button className="btn sm" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            刷新
          </button>
        }
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="row" style={{ gap: 10 }}>
              {hostName ? (
                <>
                  <span className="host-dot" style={{ background: hostDotColor(byId[hostFilter!]), width: 10, height: 10 }} />
                  {hostName}
                </>
              ) : (
                '全部容器'
              )}
            </h1>
            <p>
              {hostName
                ? `${byId[hostFilter!]?.address ?? ''} · 列表每 5 秒自动刷新`
                : `${multi ? `${hosts?.length} 台服务器上的` : ''}全部容器：启停、日志、终端与配置查看。列表每 5 秒自动刷新。`}
            </p>
          </div>
        </div>

        {error && <div className="banner warn">加载失败：{error}</div>}
        {data?.errors.map((e) => (
          <div key={e.host} className="banner warn">
            <Server size={15} style={{ flex: 'none', marginTop: 1 }} />
            <div>
              服务器 <b>{e.name}</b> 无法连接，其容器未显示：{e.error}
            </div>
          </div>
        ))}

        <div className="card">
          <div className="toolbar">
            <div className="input-icon" style={{ width: 280 }}>
              <Search size={15} />
              <input
                className="input"
                placeholder="搜索名称、镜像、ID、端口…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="icon-btn sm clear" onClick={() => setQuery('')}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="segmented">
              {FILTERS.map((f) =>
                f.key !== 'all' && f.key !== 'running' && f.key !== 'stopped' && counts[f.key] === 0 ? null : (
                  <button
                    key={f.key}
                    className={filter === f.key ? 'active' : ''}
                    onClick={() => setParam('state', f.key === 'all' ? null : f.key)}
                  >
                    {f.label}
                    <span className="num" style={f.key === 'failed' ? { color: 'var(--red)' } : undefined}>
                      {counts[f.key]}
                    </span>
                  </button>
                ),
              )}
            </div>
            {project && (
              <span className="tag accent" style={{ height: 26 }}>
                <Layers size={12} />
                项目：{project}
                <button className="icon-btn sm" style={{ width: 18, height: 18, color: 'inherit' }} onClick={() => setParam('project', null)}>
                  <X size={12} />
                </button>
              </span>
            )}
            <span className="spacer" />
            <span className="dim" style={{ fontSize: 12.5 }}>分组</span>
            <select
              className="select sm"
              value={groupBy}
              onChange={(e) => {
                setGroupPref(e.target.value as GroupBy);
                localStorage.setItem('dp-groupby', e.target.value);
              }}
            >
              {multi && !hostFilter && <option value="host">按服务器</option>}
              <option value="project">按 Compose 项目</option>
              <option value="none">不分组</option>
            </select>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {canMutate && (
                    <th className="col-check">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          ref={(el) => {
                            if (el) el.indeterminate = !allChecked && someChecked;
                          }}
                          onChange={toggleAll}
                        />
                      </label>
                    </th>
                  )}
                  <th className="sortable" onClick={() => sortBy('name')}>
                    名称 <SortIcon k="name" />
                  </th>
                  <th className="sortable" onClick={() => sortBy('state')}>
                    状态 <SortIcon k="state" />
                  </th>
                  {showHostCol && <th>服务器</th>}
                  <th>镜像</th>
                  <th>端口</th>
                  <th className="sortable" onClick={() => sortBy('created')}>
                    创建时间 <SortIcon k="created" />
                  </th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {!list &&
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={cols}>
                        <div className="skeleton" style={{ height: 22 }} />
                      </td>
                    </tr>
                  ))}
                {list && visible.length === 0 && (
                  <tr>
                    <td colSpan={cols}>
                      <div className="empty">
                        <Boxes size={30} />
                        <h4>{list.length ? '没有匹配的容器' : '还没有容器'}</h4>
                        <div>{list.length ? '试试调整搜索关键字或状态筛选' : '使用 docker run / docker compose up 创建容器后会显示在这里'}</div>
                      </div>
                    </td>
                  </tr>
                )}
                {sections.map((sec) => (
                  <Fragment key={sec.key || '_'}>
                    {effectiveGroup !== 'none' && (sections.length > 1 || sec.label) && (
                      <tr className="group-row">
                        <td colSpan={cols}>
                          <span className="row">
                            {effectiveGroup === 'host' ? (
                              <>
                                <span className="host-dot" style={{ background: hostDotColor(byId[sec.host]) }} />
                                <b style={{ fontWeight: 600, color: 'var(--text)' }}>{sec.label}</b>
                                <span className="dim mono" style={{ fontSize: 11.5 }}>
                                  {byId[sec.host]?.address}
                                </span>
                              </>
                            ) : (
                              <>
                                <Layers size={13} />
                                {sec.label || '独立容器'}
                                {showHostCol && <HostTag id={sec.host} link={false} />}
                              </>
                            )}
                            <span className="dim">
                              · {sec.items.length} 个容器，{sec.items.filter((c) => c.state === 'running').length} 个运行中
                            </span>
                          </span>
                        </td>
                      </tr>
                    )}
                    {sec.items.map((c) => (
                      <ContainerRow
                        key={busyKey(c)}
                        c={c}
                        hostCol={showHostCol}
                        selected={selected.has(busyKey(c))}
                        busy={busy[busyKey(c)]}
                        canMutate={canMutate}
                        canExec={me.allowExec}
                        onToggle={() => toggle(busyKey(c))}
                        onOpen={(tab) => navigate(`/hosts/${c.host}/containers/${c.id}${tab ? `/${tab}` : ''}`)}
                        onAction={(a) => run(a, [c])}
                        onCopy={async () => {
                          await copyText(c.id);
                          toast('success', '已复制容器 ID', shortId(c.id));
                        }}
                      />
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {canMutate && selectedItems.length > 0 && (
        <div className="bulkbar">
          <span className="count">已选 {selectedItems.length} 项</span>
          <button className="btn sm" onClick={() => bulk('start')}>
            <Play size={14} /> 启动
          </button>
          <button className="btn sm" onClick={() => bulk('stop')}>
            <Square size={13} /> 停止
          </button>
          <button className="btn sm" onClick={() => bulk('restart')}>
            <RotateCw size={14} /> 重启
          </button>
          <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => bulk('remove')}>
            <Trash2 size={14} /> 删除
          </button>
          <span className="divider" />
          <button className="icon-btn sm" title="取消选择" onClick={() => setSelected(new Set())}>
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}

/** Address to open published ports on: the remote server for SSH/TCP hosts, the current hostname for local. */
export function usePortHost(hostId: string) {
  const { byId } = useHosts();
  const h = byId[hostId];
  return h && h.type !== 'local' && h.host ? h.host : location.hostname;
}

function ContainerRow({
  c,
  hostCol,
  selected,
  busy,
  canMutate,
  canExec,
  onToggle,
  onOpen,
  onAction,
  onCopy,
}: {
  c: ContainerSummary;
  hostCol: boolean;
  selected: boolean;
  busy?: ContainerAction;
  canMutate: boolean;
  canExec: boolean;
  onToggle: () => void;
  onOpen: (tab?: string) => void;
  onAction: (a: ContainerAction) => void;
  onCopy: () => void;
}) {
  const running = c.state === 'running';
  const paused = c.state === 'paused';
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const host = usePortHost(c.host);

  return (
    <tr className={`clickable ${selected ? 'selected' : ''}`} onClick={() => onOpen()}>
      {canMutate && (
        <td className="col-check" onClick={stop}>
          <label className="check">
            <input type="checkbox" checked={selected} onChange={onToggle} />
          </label>
        </td>
      )}
      <td style={{ maxWidth: 320 }}>
        <div className="name-cell">
          <span className="name">
            <span className="truncate">{c.name}</span>
            {c.protected && (
              <span title="受保护容器：禁止停止 / 删除">
                <Shield size={13} color="var(--yellow)" />
              </span>
            )}
          </span>
          <span className="sub">
            <span className="mono">{shortId(c.id)}</span>
            {c.service && <span className="tag" style={{ height: 17, fontSize: 11 }}>{c.service}</span>}
          </span>
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
          {busy ? (
            <span className="badge tone-blue">
              <RefreshCw size={11} className="spin" />
              处理中
            </span>
          ) : (
            <StateBadge c={c} />
          )}
          <span className="dim" style={{ fontSize: 11.5 }}>
            {c.status}
          </span>
        </div>
      </td>
      {hostCol && (
        <td onClick={stop}>
          <HostTag id={c.host} />
        </td>
      )}
      <td style={{ maxWidth: 260 }}>
        <span className="truncate mono" style={{ display: 'block' }} title={c.image}>
          {c.image.startsWith('sha256:') ? shortId(c.image) : c.image}
        </span>
      </td>
      <td onClick={stop}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4, maxWidth: 240 }}>
          {c.ports.length === 0 && <span className="dim">—</span>}
          {c.ports.slice(0, 4).map((p) =>
            p.public ? (
              <a
                key={`${p.public}-${p.private}-${p.type}`}
                className="tag mono"
                href={`http://${host}:${p.public}`}
                target="_blank"
                rel="noreferrer noopener"
                title={`${p.ip || '0.0.0.0'}:${p.public} → ${p.private}/${p.type}`}
              >
                {p.public}→{p.private}
              </a>
            ) : (
              <span key={`${p.private}-${p.type}`} className="tag mono dim" title="未映射到宿主机">
                {p.private}/{p.type}
              </span>
            ),
          )}
          {c.ports.length > 4 && <span className="dim">+{c.ports.length - 4}</span>}
        </div>
      </td>
      <td className="nowrap" title={formatDate(c.created)}>
        <span className="muted">{timeAgo(c.created)}</span>
      </td>
      <td className="col-actions" onClick={stop}>
        <div className="row-actions">
          {canMutate &&
            (running || paused ? (
              <button
                className="icon-btn sm warn"
                title="停止"
                disabled={!!busy || c.protected}
                onClick={() => onAction('stop')}
              >
                <Square size={14} />
              </button>
            ) : (
              <button className="icon-btn sm success" title="启动" disabled={!!busy} onClick={() => onAction('start')}>
                <Play size={15} />
              </button>
            ))}
          {canMutate && (
            <button className="icon-btn sm" title="重启" disabled={!!busy || c.protected} onClick={() => onAction('restart')}>
              <RotateCw size={14} />
            </button>
          )}
          <button className="icon-btn sm" title="日志" onClick={() => onOpen('logs')}>
            <FileText size={15} />
          </button>
          {canExec && (
            <button className="icon-btn sm" title={running ? '终端' : '容器未运行'} disabled={!running} onClick={() => onOpen('terminal')}>
              <SquareTerminal size={15} />
            </button>
          )}
          <MenuButton
            title="更多"
            trigger={<MoreHorizontal size={16} />}
            items={[
              ...(canMutate
                ? [
                    paused
                      ? { label: '恢复运行', icon: <Play size={15} />, onClick: () => onAction('unpause') }
                      : {
                          label: '暂停',
                          icon: <Pause size={15} />,
                          disabled: !running || c.protected,
                          onClick: () => onAction('pause'),
                        },
                    {
                      label: '强制终止 (kill)',
                      icon: <Skull size={15} />,
                      disabled: !(running || paused) || c.protected,
                      onClick: () => onAction('kill'),
                    },
                  ]
                : []),
              { label: '复制容器 ID', icon: <Copy size={15} />, onClick: onCopy },
              ...(canMutate
                ? [
                    { label: '', divider: true },
                    {
                      label: '删除容器',
                      icon: <Trash2 size={15} />,
                      danger: true,
                      disabled: c.protected,
                      onClick: () => onAction('remove'),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </td>
    </tr>
  );
}
