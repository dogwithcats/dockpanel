import { Boxes, Container, LayoutDashboard, LogOut, Moon, ScrollText, Server, Sun } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { HostsCtx, usePolling, useHosts, useSession, useTheme } from '../lib/hooks';
import type { Host } from '../lib/types';

/** Loads the server list once and refreshes it every 15s for every page. */
export function HostsProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const refresh = useCallback(async () => {
    try {
      setHosts(await api.hosts());
    } catch {
      /* keep the last known list */
    }
  }, []);
  usePolling(refresh, 15000);
  const value = useMemo(
    () => ({
      hosts,
      byId: Object.fromEntries((hosts || []).map((h) => [h.id, h])),
      refresh,
      multi: (hosts?.length ?? 0) > 1,
    }),
    [hosts, refresh],
  );
  return <HostsCtx.Provider value={value}>{children}</HostsCtx.Provider>;
}

export function hostDotColor(h?: Host) {
  if (!h) return 'var(--text-3)';
  return h.status.state === 'online' ? 'var(--green)' : h.status.state === 'offline' ? 'var(--red)' : 'var(--text-3)';
}

export function Layout() {
  const { me, logout } = useSession();
  const { theme, toggle } = useTheme();
  const { hosts } = useHosts();
  const [params] = useSearchParams();
  const loc = useLocation();

  const online = (hosts || []).filter((h) => h.status.state === 'online').length;
  const totals = (hosts || []).reduce(
    (a, h) => ({ running: a.running + (h.status.info?.running ?? 0), all: a.all + (h.status.info?.containers ?? 0) }),
    { running: 0, all: 0 },
  );
  const activeHost = loc.pathname.endsWith('/containers') ? params.get('host') : null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand" style={{ color: 'inherit' }}>
          <div className="brand-mark">
            <Container size={16} strokeWidth={2.4} />
          </div>
          <div className="brand-name">
            Dock<span>Panel</span>
          </div>
        </Link>

        <nav className="nav" style={{ overflow: 'auto', flex: 1 }}>
          <div className="nav-section">工作台</div>
          <NavLink to="/" end>
            <LayoutDashboard size={16} />
            <span>概览</span>
          </NavLink>
          <NavLink to="/containers" className={({ isActive }) => (isActive && !activeHost ? 'active' : '')} end>
            <Boxes size={16} />
            <span>全部容器</span>
            {hosts && (
              <span className="count">
                {totals.running}/{totals.all}
              </span>
            )}
          </NavLink>

          <div className="nav-section row" style={{ paddingRight: 6 }}>
            <span className="grow">服务器</span>
            {hosts && (
              <span style={{ textTransform: 'none', letterSpacing: 0 }}>
                {online}/{hosts.length} 在线
              </span>
            )}
          </div>
          {hosts?.map((h) => (
            <Link
              key={h.id}
              to={`/containers?host=${h.id}`}
              className={activeHost === h.id ? 'active' : ''}
              title={h.status.state === 'offline' ? h.status.error : h.address}
            >
              <span className="host-dot" style={{ background: hostDotColor(h) }} />
              <span className="truncate">{h.name}</span>
              <span className="count">
                {h.status.state === 'online' ? `${h.status.info?.running ?? 0}/${h.status.info?.containers ?? 0}` : h.status.state === 'offline' ? '离线' : ''}
              </span>
            </Link>
          ))}
          <NavLink to="/hosts" end>
            <Server size={16} />
            <span>服务器管理</span>
          </NavLink>

          <div className="nav-section">安全</div>
          <NavLink to="/audit">
            <ScrollText size={16} />
            <span>操作审计</span>
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          <div className="avatar">{me.user.slice(0, 1)}</div>
          <div className="grow">
            <div style={{ fontWeight: 550, fontSize: 13 }}>{me.user}</div>
            <div className="dim" style={{ fontSize: 11.5 }}>
              {me.readOnly ? '只读模式' : '管理员'}
            </div>
          </div>
          <button className="icon-btn" onClick={toggle} title={theme === 'dark' ? '切换到浅色' : '切换到深色'}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="icon-btn danger" onClick={logout} title="退出登录">
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function Topbar({ crumbs, right }: { crumbs: { label: ReactNode; to?: string }[]; right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="crumbs grow">
        {crumbs.map((c, i) => (
          <span key={i} className="row" style={{ gap: 6, minWidth: 0 }}>
            {i > 0 && <span className="sep">/</span>}
            {c.to ? <Link to={c.to}>{c.label}</Link> : <strong className="truncate">{c.label}</strong>}
          </span>
        ))}
      </div>
      {right}
    </header>
  );
}

/** Small host label used next to container names when several servers are configured. */
export function HostTag({ id, link = true }: { id: string; link?: boolean }) {
  const { byId } = useHosts();
  const h = byId[id];
  const body = (
    <>
      <span className="host-dot" style={{ background: hostDotColor(h), width: 6, height: 6 }} />
      {h?.name ?? id}
    </>
  );
  return link ? (
    <Link to={`/containers?host=${id}`} className="tag" onClick={(e) => e.stopPropagation()}>
      {body}
    </Link>
  ) : (
    <span className="tag">{body}</span>
  );
}
