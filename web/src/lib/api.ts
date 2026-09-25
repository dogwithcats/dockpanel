import type {
  AuditEntry,
  ContainerAction,
  ContainerInspect,
  ContainersResponse,
  FileContent,
  FileListing,
  FileMounts,
  Host,
  HostInput,
  HostTestResult,
  Me,
} from './types';

/**
 * Sub-path the app is mounted under, e.g. "/dockerpanel" ("" at domain root).
 * The server injects <base href="…/"> into index.html; in Vite dev there is no <base> tag.
 */
export const BASE_PATH = (document.querySelector('base')?.getAttribute('href') || '').replace(/\/+$/, '');

/** Prefix an app-absolute path ("/api/…") with BASE_PATH. */
export const withBase = (p: string) => `${BASE_PATH}${p}`;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(withBase(url), {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('dp:unauthorized'));
    const msg = (data as { error?: string } | null)?.error || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  me: () => request<Me>('GET', '/api/auth/me'),
  login: (username: string, password: string) => request<{ user: string }>('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  hosts: (probe = true) => request<Host[]>('GET', `/api/hosts${probe ? '' : '?probe=0'}`),
  testHost: (input: HostInput) => request<HostTestResult>('POST', '/api/hosts/test', input),
  addHost: (input: HostInput) => request<Host>('POST', '/api/hosts', input),
  updateHost: (id: string, input: HostInput) => request<Host>('PUT', `/api/hosts/${enc(id)}`, input),
  removeHost: (id: string) => request('DELETE', `/api/hosts/${enc(id)}`),
  reorderHosts: (ids: string[]) => request('PUT', '/api/hosts/order', { ids }),

  containers: (host?: string) => request<ContainersResponse>('GET', `/api/containers${host ? `?host=${enc(host)}` : ''}`),
  container: (host: string, id: string) => request<ContainerInspect>('GET', `${hostPath(host)}/containers/${enc(id)}`),
  action: (host: string, id: string, action: Exclude<ContainerAction, 'remove'>) =>
    request('POST', `${hostPath(host)}/containers/${enc(id)}/${action}`, {}),
  remove: (host: string, id: string, opts: { force?: boolean; volumes?: boolean }) =>
    request(
      'DELETE',
      `${hostPath(host)}/containers/${enc(id)}?force=${opts.force ? 1 : 0}&volumes=${opts.volumes ? 1 : 0}`,
    ),
  /** Container file browser (bind mounts). */
  files: {
    base: (host: string, id: string) => `${hostPath(host)}/containers/${enc(id)}/files`,
    mounts: (host: string, id: string) => request<FileMounts>('GET', `${hostPath(host)}/containers/${enc(id)}/files/mounts`),
    list: (host: string, id: string, mount: string, path: string) =>
      request<FileListing>('GET', `${hostPath(host)}/containers/${enc(id)}/files/entries?mount=${enc(mount)}&path=${enc(path)}`),
    read: (host: string, id: string, mount: string, path: string) =>
      request<FileContent>('GET', `${hostPath(host)}/containers/${enc(id)}/files/file?mount=${enc(mount)}&path=${enc(path)}`),
    write: (host: string, id: string, mount: string, path: string, content: string) =>
      request<{ ok: true; bytes: number }>('PUT', `${hostPath(host)}/containers/${enc(id)}/files/file`, { mount, path, content }),
    mkdir: (host: string, id: string, mount: string, path: string) =>
      request('POST', `${hostPath(host)}/containers/${enc(id)}/files/mkdir`, { mount, path }),
    rename: (host: string, id: string, mount: string, from: string, to: string) =>
      request('POST', `${hostPath(host)}/containers/${enc(id)}/files/rename`, { mount, from, to }),
    chmod: (host: string, id: string, mount: string, path: string, mode: string) =>
      request('POST', `${hostPath(host)}/containers/${enc(id)}/files/chmod`, { mount, path, mode }),
    remove: (host: string, id: string, mount: string, path: string, recursive: boolean) =>
      request(
        'DELETE',
        `${hostPath(host)}/containers/${enc(id)}/files/path?mount=${enc(mount)}&path=${enc(path)}${recursive ? '&recursive=1' : ''}`,
      ),
  },
  audit: () => request<AuditEntry[]>('GET', '/api/audit'),
};

const enc = encodeURIComponent;
export const hostPath = (host: string) => `/api/hosts/${enc(host)}`;
export const wsContainerPath = (host: string, id: string, kind: 'logs' | 'exec' | 'stats') =>
  `/ws/hosts/${enc(host)}/containers/${enc(id)}/${kind}`;

export function wsUrl(path: string) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${withBase(path)}`;
}
