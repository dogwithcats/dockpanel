import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, withBase } from '../lib/api';
import type { FileMounts } from '../lib/types';

export interface FilesApi {
  hostId: string;
  containerId: string;
  /** Mounts of this container, loaded on demand by the file browser. */
  mounts: FileMounts | null;
  loadMounts: () => Promise<FileMounts>;
  list: (mount: string, path: string) => ReturnType<typeof api.files.list>;
  read: (mount: string, path: string) => ReturnType<typeof api.files.read>;
  write: (mount: string, path: string, content: string) => ReturnType<typeof api.files.write>;
  mkdir: (mount: string, path: string) => ReturnType<typeof api.files.mkdir>;
  rename: (mount: string, from: string, to: string) => ReturnType<typeof api.files.rename>;
  chmod: (mount: string, path: string, mode: string) => ReturnType<typeof api.files.chmod>;
  remove: (mount: string, path: string, recursive?: boolean) => ReturnType<typeof api.files.remove>;
  downloadUrl: (mount: string, path: string) => string;
  uploadUrl: (mount: string, path: string, name?: string) => string;
}

const FilesCtx = createContext<FilesApi | null>(null);

export function useFilesApi(): FilesApi {
  const ctx = useContext(FilesCtx);
  if (!ctx) throw new Error('FilesCtx missing');
  return ctx;
}

export function FilesProvider({
  hostId,
  containerId,
  children,
}: {
  hostId: string;
  containerId: string;
  children: ReactNode;
}) {
  const [mounts, setMounts] = useState<FileMounts | null>(null);

  const value = useMemo<FilesApi>(() => {
    const base = api.files.base(hostId, containerId);
    const query = (params: Record<string, string | undefined>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
      const s = p.toString();
      return s ? `?${s}` : '';
    };
    return {
      hostId,
      containerId,
      mounts,
      loadMounts: async () => {
        const m = await api.files.mounts(hostId, containerId);
        setMounts(m);
        return m;
      },
      list: (mount, path) => api.files.list(hostId, containerId, mount, path),
      read: (mount, path) => api.files.read(hostId, containerId, mount, path),
      write: (mount, path, content) => api.files.write(hostId, containerId, mount, path, content),
      mkdir: (mount, path) => api.files.mkdir(hostId, containerId, mount, path),
      rename: (mount, from, to) => api.files.rename(hostId, containerId, mount, from, to),
      chmod: (mount, path, mode) => api.files.chmod(hostId, containerId, mount, path, mode),
      remove: (mount, path, recursive = false) => api.files.remove(hostId, containerId, mount, path, recursive),
      downloadUrl: (mount, path) => withBase(`${base}/download${query({ mount, path })}`),
      uploadUrl: (mount, path, name) => withBase(`${base}/upload${query({ mount, path, name })}`),
    };
  }, [hostId, containerId, mounts]);

  return <FilesCtx.Provider value={value}>{children}</FilesCtx.Provider>;
}
