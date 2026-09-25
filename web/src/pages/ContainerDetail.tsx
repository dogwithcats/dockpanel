import {
  Activity,
  AlertTriangle,
  Box,
  Braces,
  Check,
  Clock,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderTree,
  HardDrive,
  Hash,
  Info,
  Layers,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  RotateCw,
  Shield,
  Skull,
  Square,
  SquareTerminal,
  Tag,
  Trash2,
  Variable,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFeedback } from '../components/Feedback';
import { FileBrowser } from '../components/FileBrowser';
import { FilesProvider } from '../components/FilesCtx';
import { hostDotColor, Topbar } from '../components/Layout';
import { LogViewer } from '../components/LogViewer';
import { MenuButton } from '../components/Menu';
import { StateBadge } from '../components/StateBadge';
import { StatsPanel } from '../components/StatsPanel';
import { ExecTerminal } from '../components/Terminal';
import { api } from '../lib/api';
import { copyText, formatBytes, formatDate, formatDuration, SENSITIVE_KEY, shortId, stateGroup, timeAgo } from '../lib/format';
import { busyKey, useContainerActions, useHosts, usePolling, useSession } from '../lib/hooks';
import { usePortHost } from './Containers';
import type { ContainerAction, ContainerInspect } from '../lib/types';

type TabKey = 'overview' | 'logs' | 'files' | 'terminal' | 'config';

export function ContainerDetail() {
  const { hostId = '', id = '', tab = 'overview' } = useParams();
  const { byId, multi } = useHosts();
  const host = byId[hostId];
  const base = `/hosts/${hostId}/containers/${id}`;
  const navigate = useNavigate();
  const { me } = useSession();
  const { toast } = useFeedback();
  const [info, setInfo] = useState<ContainerInspect | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([tab]));

  const current = (['overview', 'logs', 'files', 'terminal', 'config'].includes(tab) ? tab : 'overview') as TabKey;

  useEffect(() => {
    setVisited((v) => (v.has(current) ? v : new Set(v).add(current)));
  }, [current]);

  const load = usePolling(
    async () => {
      try {
        setInfo(await api.container(hostId, id));
        setNotFound(false);
      } catch (e) {
        if ((e as { status?: number }).status === 404) setNotFound(true);
      }
    },
    5000,
    [hostId, id],
  );

  const refresh = useCallback(() => void load(), [load]);
  const { run, busy } = useContainerActions(refresh);

  if (notFound) {
    return (
      <>
        <Topbar crumbs={[{ label: '容器', to: '/containers' }, { label: host?.name ?? hostId, to: `/containers?host=${hostId}` }, { label: shortId(id) }]} />
        <div className="content">
          <div className="card empty">
            <Box size={30} />
            <h4>容器不存在</h4>
            <div>它可能已被删除，或所在服务器的连接已变化。</div>
            <Link to="/containers" className="btn" style={{ marginTop: 14 }}>
              返回容器列表
            </Link>
          </div>
        </div>
      </>
    );
  }

  const name = info ? info.Name.replace(/^\//, '') : shortId(id);
  const labels = info?.Config.Labels || {};
  const isProtected = labels['dockpanel.protected'] === 'true';
  const summary = info
    ? {
        host: hostId,
        id: info.Id,
        name,
        state: info.State.Status,
        protected: isProtected,
        status: info.State.Status === 'exited' ? `Exited (${info.State.ExitCode})` : info.State.Status,
      }
    : null;
  const running = !!info?.State.Running && !info.State.Paused;
  const paused = !!info?.State.Paused;
  const canMutate = !me.readOnly;
  const isBusy = summary ? !!busy[busyKey(summary)] : false;
  const group = summary ? stateGroup(summary) : 'stopped';
  const tone = { running: 'tone-green', paused: 'tone-yellow', failed: 'tone-red', stopped: 'tone-gray' }[group];

  const act = async (a: ContainerAction) => {
    if (!summary) return;
    const ok = await run(a, [summary]);
    if (ok && a === 'remove') navigate('/containers');
  };

  const tabs: { key: TabKey; label: string; icon: React.ReactNode; hidden?: boolean }[] = [
    { key: 'overview', label: '概览', icon: <Activity size={15} /> },
    { key: 'logs', label: '日志', icon: <FileText size={15} /> },
    { key: 'files', label: '文件', icon: <FolderTree size={15} /> },
    { key: 'terminal', label: '终端', icon: <SquareTerminal size={15} />, hidden: !me.allowExec },
    { key: 'config', label: '配置', icon: <Braces size={15} /> },
  ];

  return (
    <>
      <Topbar
        crumbs={[
          { label: '容器', to: '/containers' },
          ...(multi || host?.type !== 'local' ? [{ label: host?.name ?? hostId, to: `/containers?host=${hostId}` }] : []),
          { label: name },
        ]}
      />
      <div className="content flush">
        <div className="detail-head">
          <div className={`icon ${tone}`}>
            <Box size={21} />
          </div>
          <div className="grow">
            <h1>
              <span className="truncate">{name}</span>
              {summary && <StateBadge c={summary} health={info?.State.Health?.Status} />}
              {isProtected && (
                <span className="tag warn">
                  <Shield size={12} /> 受保护
                </span>
              )}
            </h1>
            <div className="meta">
              {host && (multi || host.type !== 'local') && (
                <span>
                  <span className="host-dot" style={{ background: hostDotColor(host), width: 7, height: 7 }} />
                  {host.name}
                </span>
              )}
              <span
                className="mono"
                style={{ cursor: 'pointer' }}
                title="点击复制完整 ID"
                onClick={async () => {
                  await copyText(info?.Id || id);
                  toast('success', '已复制容器 ID');
                }}
              >
                <Hash size={13} />
                {shortId(info?.Id || id)}
                <Copy size={11} />
              </span>
              {info && (
                <span className="mono">
                  <Layers size={13} />
                  {info.Config.Image}
                </span>
              )}
              {info && (
                <span>
                  <Clock size={13} />
                  {info.State.Running
                    ? `已运行 ${formatDuration(info.State.StartedAt)}`
                    : info.State.FinishedAt && !info.State.FinishedAt.startsWith('0001')
                      ? `停止于 ${timeAgo(info.State.FinishedAt)}`
                      : `创建于 ${timeAgo(info.Created)}`}
                </span>
              )}
              {info && info.RestartCount > 0 && (
                <span style={{ color: 'var(--yellow)' }}>
                  <RotateCw size={13} />
                  已重启 {info.RestartCount} 次
                </span>
              )}
              {info?.State.OOMKilled && (
                <span style={{ color: 'var(--red)' }}>
                  <AlertTriangle size={13} /> 曾因内存不足被杀死 (OOM)
                </span>
              )}
            </div>
          </div>
          {canMutate && info && (
            <div className="row">
              {running || paused ? (
                <button className="btn" disabled={isBusy || isProtected} onClick={() => act('stop')}>
                  <Square size={14} /> 停止
                </button>
              ) : (
                <button className="btn primary" disabled={isBusy} onClick={() => act('start')}>
                  <Play size={14} /> 启动
                </button>
              )}
              <button className="btn" disabled={isBusy || isProtected} onClick={() => act('restart')}>
                <RotateCw size={14} className={summary && busy[busyKey(summary)] === 'restart' ? 'spin' : ''} /> 重启
              </button>
              <MenuButton
                title="更多操作"
                trigger={<MoreHorizontal size={16} />}
                items={[
                  paused
                    ? { label: '恢复运行', icon: <Play size={15} />, onClick: () => act('unpause') }
                    : { label: '暂停', icon: <Pause size={15} />, disabled: !running || isProtected, onClick: () => act('pause') },
                  {
                    label: '强制终止 (kill)',
                    icon: <Skull size={15} />,
                    disabled: !(running || paused) || isProtected,
                    onClick: () => act('kill'),
                  },
                  { label: '', divider: true },
                  { label: '删除容器', icon: <Trash2 size={15} />, danger: true, disabled: isProtected, onClick: () => act('remove') },
                ]}
              />
            </div>
          )}
        </div>

        <nav className="tabs">
          {tabs
            .filter((t) => !t.hidden)
            .map((t) => (
              <Link
                key={t.key}
                to={`${base}${t.key === 'overview' ? '' : `/${t.key}`}`}
                className={current === t.key ? 'active' : ''}
                replace
              >
                {t.icon}
                {t.label}
              </Link>
            ))}
        </nav>

        <section className="tab-panel" hidden={current !== 'overview'}>
          <div className="tab-scroll">{info && <Overview hostId={hostId} info={info} active={current === 'overview'} />}</div>
        </section>
        {visited.has('logs') && (
          <section className="tab-panel" hidden={current !== 'logs'}>
            <LogViewer hostId={hostId} containerId={id} active={current === 'logs'} />
          </section>
        )}
        {visited.has('files') && (
          <section className="tab-panel" hidden={current !== 'files'}>
            <FilesProvider hostId={hostId} containerId={id}>
              <FileBrowser active={current === 'files'} />
            </FilesProvider>
          </section>
        )}
        {me.allowExec && visited.has('terminal') && info && (
          <section className="tab-panel" hidden={current !== 'terminal'}>
            <ExecTerminal hostId={hostId} containerId={id} containerName={name} running={running} active={current === 'terminal'} />
          </section>
        )}
        {visited.has('config') && info && (
          <section className="tab-panel" hidden={current !== 'config'}>
            <div className="tab-scroll">
              <Config info={info} />
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/* ================================================================ overview */

function Overview({ hostId, info, active }: { hostId: string; info: ContainerInspect; active: boolean }) {
  const portHost = usePortHost(hostId);
  const cmd = [...(info.Config.Entrypoint || []), ...(info.Config.Cmd || [])].join(' ');
  const rp = info.HostConfig.RestartPolicy;
  const ports = Object.entries(info.NetworkSettings.Ports || {});
  const networks = Object.entries(info.NetworkSettings.Networks || {});
  const health = info.State.Health;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {active && <StatsPanel hostId={hostId} containerId={info.Id} running={info.State.Running && !info.State.Paused} />}

      {info.State.Error && (
        <div className="banner warn" style={{ margin: 0 }}>
          <AlertTriangle size={15} />
          <div>{info.State.Error}</div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <Info size={15} className="dim" />
            <h3>基本信息</h3>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>容器 ID</dt>
              <dd className="mono">{info.Id}</dd>
              <dt>镜像</dt>
              <dd className="mono">{info.Config.Image}</dd>
              <dt>启动命令</dt>
              <dd className="mono">{cmd || '—'}</dd>
              <dt>工作目录</dt>
              <dd className="mono">{info.Config.WorkingDir || '/'}</dd>
              <dt>运行用户</dt>
              <dd className="mono">{info.Config.User || 'root (默认)'}</dd>
              <dt>创建时间</dt>
              <dd>{formatDate(info.Created)}</dd>
              <dt>启动时间</dt>
              <dd>{info.State.StartedAt.startsWith('0001') ? '—' : formatDate(info.State.StartedAt)}</dd>
              <dt>重启策略</dt>
              <dd>
                {rp?.Name || 'no'}
                {rp?.Name === 'on-failure' && rp.MaximumRetryCount ? ` (最多 ${rp.MaximumRetryCount} 次)` : ''}
              </dd>
              <dt>资源限制</dt>
              <dd>
                CPU {info.HostConfig.NanoCpus ? `${info.HostConfig.NanoCpus / 1e9} 核` : '不限'} · 内存{' '}
                {info.HostConfig.Memory ? formatBytes(info.HostConfig.Memory) : '不限'}
              </dd>
              {info.HostConfig.Privileged && (
                <>
                  <dt>特权模式</dt>
                  <dd style={{ color: 'var(--yellow)' }}>已开启 (privileged)</dd>
                </>
              )}
              {!info.State.Running && (
                <>
                  <dt>退出码</dt>
                  <dd className="mono">{info.State.ExitCode}</dd>
                </>
              )}
              {health && (
                <>
                  <dt>健康检查</dt>
                  <dd>
                    <span
                      style={{
                        color:
                          health.Status === 'healthy' ? 'var(--green)' : health.Status === 'unhealthy' ? 'var(--red)' : 'var(--yellow)',
                      }}
                    >
                      {health.Status}
                    </span>
                    {health.FailingStreak > 0 && <span className="dim"> · 连续失败 {health.FailingStreak} 次</span>}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <div className="card-head">
              <Network size={15} className="dim" />
              <h3>网络与端口</h3>
            </div>
            <div className="card-body">
              {networks.length === 0 && ports.length === 0 && <div className="dim">无网络配置（{info.HostConfig.NetworkMode}）</div>}
              {networks.map(([n, v]) => (
                <div key={n} className="row" style={{ padding: '4px 0', flexWrap: 'wrap' }}>
                  <span className="tag accent">{n}</span>
                  <span className="mono">{v.IPAddress || '—'}</span>
                  {v.Gateway && <span className="dim mono">gw {v.Gateway}</span>}
                </div>
              ))}
              {ports.length > 0 && (
                <div style={{ marginTop: networks.length ? 12 : 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ports.map(([p, binds]) => {
                    const uniq = [...new Set((binds || []).map((b) => b.HostPort))];
                    return uniq.length ? (
                      uniq.map((hp) => (
                        <a
                          key={p + hp}
                          className="tag mono"
                          href={`http://${portHost}:${hp}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {hp} → {p}
                        </a>
                      ))
                    ) : (
                      <span key={p} className="tag mono dim">
                        {p}（未发布）
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <HardDrive size={15} className="dim" />
              <h3>挂载</h3>
              <span className="hint">{info.Mounts.length || ''}</span>
            </div>
            <div className="card-body" style={{ paddingTop: 8, paddingBottom: 8 }}>
              {info.Mounts.length === 0 && <div className="dim" style={{ padding: '8px 0' }}>无挂载</div>}
              {info.Mounts.map((m) => (
                <div key={m.Destination} className="env-row" style={{ gridTemplateColumns: '1fr auto' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="k">{m.Destination}</div>
                    <div className="v" style={{ fontSize: 11.5 }}>
                      {m.Type === 'volume' ? `volume: ${m.Name}` : m.Source}
                    </div>
                  </div>
                  <span className={`tag ${m.RW ? '' : 'warn'}`}>
                    {m.Type} · {m.RW ? '读写' : '只读'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <EnvCard env={info.Config.Env || []} />
    </div>
  );
}

function EnvCard({ env }: { env: string[] }) {
  const [reveal, setReveal] = useState(false);
  const { toast } = useFeedback();
  const rows = useMemo(
    () =>
      env.map((e) => {
        const i = e.indexOf('=');
        return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)];
      }),
    [env],
  );
  const sensitiveCount = rows.filter(([k]) => SENSITIVE_KEY.test(k)).length;

  return (
    <div className="card">
      <div className="card-head">
        <Variable size={15} className="dim" />
        <h3>环境变量</h3>
        <span className="hint">{rows.length}</span>
        <span className="spacer" />
        {sensitiveCount > 0 && (
          <button className="btn ghost sm" onClick={() => setReveal((r) => !r)}>
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            {reveal ? '隐藏敏感值' : `显示敏感值 (${sensitiveCount})`}
          </button>
        )}
      </div>
      <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
        {rows.length === 0 && <div className="dim" style={{ padding: '10px 0' }}>无环境变量</div>}
        {rows.map(([k, v]) => {
          const masked = !reveal && SENSITIVE_KEY.test(k);
          return (
            <div key={k} className="env-row">
              <span className="k">{k}</span>
              <span className="v">{masked ? '••••••••' : v}</span>
              <button
                className="icon-btn sm"
                title="复制值"
                onClick={async () => {
                  await copyText(v);
                  toast('success', `已复制 ${k}`);
                }}
              >
                <Copy size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================================================================== config */

function Config({ info }: { info: ContainerInspect }) {
  const [copied, setCopied] = useState(false);
  const labels = Object.entries(info.Config.Labels || {}).sort(([a], [b]) => a.localeCompare(b));
  // Mask env values that look like secrets in the raw JSON view too
  const json = useMemo(() => {
    const clone = structuredClone(info);
    clone.Config.Env = (clone.Config.Env || []).map((e) => {
      const i = e.indexOf('=');
      return i > 0 && SENSITIVE_KEY.test(e.slice(0, i)) ? `${e.slice(0, i)}=••••••••` : e;
    });
    return JSON.stringify(clone, null, 2);
  }, [info]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-head">
          <Tag size={15} className="dim" />
          <h3>标签 (Labels)</h3>
          <span className="hint">{labels.length}</span>
        </div>
        <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
          {labels.length === 0 && <div className="dim" style={{ padding: '10px 0' }}>无标签</div>}
          {labels.map(([k, v]) => (
            <div key={k} className="env-row" style={{ gridTemplateColumns: 'minmax(200px, 40%) 1fr' }}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Braces size={15} className="dim" />
          <h3>docker inspect</h3>
          <span className="hint">敏感环境变量已脱敏</span>
          <span className="spacer" />
          <button
            className="btn ghost sm"
            onClick={async () => {
              await copyText(json);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制 JSON'}
          </button>
        </div>
        <div className="card-body">
          <pre className="code">{json}</pre>
        </div>
      </div>
    </div>
  );
}
