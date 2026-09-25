import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';
import type { ContainerAction, ContainerSummary, Host, Me } from './types';
import { useFeedback } from '../components/Feedback';

/* ------------------------------------------------------------- session */

export const SessionCtx = createContext<{ me: Me; logout: () => void } | null>(null);

export function useSession() {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('SessionCtx missing');
  return s;
}

/* --------------------------------------------------------------- hosts */

export interface HostsState {
  hosts: Host[] | null;
  byId: Record<string, Host>;
  refresh: () => Promise<void>;
  /** Only show host UI (columns, filters) when more than one server is configured. */
  multi: boolean;
}

export const HostsCtx = createContext<HostsState | null>(null);

export function useHosts() {
  const h = useContext(HostsCtx);
  if (!h) throw new Error('HostsCtx missing');
  return h;
}

/* --------------------------------------------------------------- theme */

export type Theme = 'dark' | 'light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('dp-theme') as Theme) || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('dp-theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

/* ------------------------------------------------------------- polling */

/** Run `fn` now and every `ms` while the tab is visible. Returns a manual refresh function. */
export function usePolling(fn: () => Promise<unknown> | void, ms: number, deps: unknown[] = []) {
  const run = useCallback(fn, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      stop();
      run();
      timer = setInterval(run, ms);
    };
    const stop = () => timer && clearInterval(timer);
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [run, ms]);
  return run;
}

/* ---------------------------------------------------- container actions */

export const ACTION_LABEL: Record<ContainerAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  pause: '暂停',
  unpause: '恢复',
  kill: '强制终止',
  remove: '删除',
};

type Target = Pick<ContainerSummary, 'host' | 'id' | 'name' | 'state' | 'protected'>;

export const busyKey = (t: Pick<ContainerSummary, 'host' | 'id'>) => `${t.host}/${t.id}`;

const GUARDED: ContainerAction[] = ['stop', 'restart', 'pause', 'kill', 'remove'];

export function useContainerActions(onDone?: () => void) {
  const { toast, confirm } = useFeedback();
  const { byId, multi } = useHosts();
  const [busy, setBusy] = useState<Record<string, ContainerAction>>({});
  // Container IDs are only unique per daemon
  const label = (t: Target) => (multi ? `${byId[t.host]?.name ?? t.host} / ${t.name}` : t.name);

  const run = useCallback(
    async (action: ContainerAction, all: Target[]) => {
      const actionLabel = ACTION_LABEL[action];
      const blocked = GUARDED.includes(action) ? all.filter((t) => t.protected) : [];
      const targets = all.filter((t) => !blocked.includes(t));
      if (blocked.length) toast('info', `已跳过 ${blocked.length} 个受保护容器`, blocked.map(label).join(', '));
      if (!targets.length) return false;

      const names = targets.map(label);
      const subject = targets.length > 1 ? `${targets.length} 个容器` : `容器 ${names[0]}`;
      let opts: Record<string, boolean> = {};

      if (action === 'remove') {
        const anyRunning = targets.some((t) => t.state === 'running' || t.state === 'paused' || t.state === 'restarting');
        const r = await confirm({
          title: `删除${subject}？`,
          message: '删除后容器及其可写层数据将无法恢复，镜像和命名数据卷不受影响。',
          items: targets.length > 1 ? names : undefined,
          confirmText: '删除',
          danger: true,
          options: [
            { key: 'force', label: anyRunning ? '强制删除（运行中的容器会先被终止）' : '强制删除', defaultValue: anyRunning },
            { key: 'volumes', label: '同时删除关联的匿名数据卷' },
          ],
        });
        if (!r) return false;
        opts = r;
      } else if (action === 'stop' || action === 'restart' || action === 'kill' || action === 'pause') {
        const r = await confirm({
          title: `${actionLabel}${subject}？`,
          message:
            action === 'kill'
              ? '将发送 SIGKILL 立即终止进程，未落盘的数据可能丢失。'
              : action === 'stop'
                ? '将发送 SIGTERM，10 秒后仍未退出则强制终止。'
                : action === 'restart'
                  ? '容器会先停止再启动，期间服务不可用。'
                  : '容器内所有进程将被冻结，直到恢复。',
          items: targets.length > 1 ? names : undefined,
          confirmText: actionLabel,
          danger: action === 'kill',
        });
        if (!r) return false;
      }

      setBusy((b) => ({ ...b, ...Object.fromEntries(targets.map((t) => [busyKey(t), action])) }));
      const results = await Promise.allSettled(
        targets.map((t) =>
          action === 'remove'
            ? api.remove(t.host, t.id, { force: opts.force, volumes: opts.volumes })
            : api.action(t.host, t.id, action),
        ),
      );
      setBusy((b) => {
        const n = { ...b };
        for (const t of targets) delete n[busyKey(t)];
        return n;
      });

      const failed = results
        .map((r, i) => (r.status === 'rejected' ? `${names[i]}: ${(r.reason as Error).message}` : null))
        .filter(Boolean) as string[];
      const okCount = results.length - failed.length;
      if (okCount) toast('success', `${actionLabel}成功`, targets.length > 1 ? `${okCount} / ${targets.length} 个容器` : names[0]);
      if (failed.length) toast('error', `${actionLabel}失败`, failed.join('\n'));
      onDone?.();
      return failed.length === 0;
    },
    [confirm, toast, onDone, byId, multi], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return { run, busy };
}
