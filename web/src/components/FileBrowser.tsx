import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  File,
  FileCode,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  WrapText,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFeedback } from './Feedback';
import { MenuButton } from './Menu';
import { useFilesApi } from './FilesCtx';
import { copyText, formatBytes, formatDate, SENSITIVE_KEY } from '../lib/format';
import type { FileEntry, FileMount } from '../lib/types';

const TEXT_EXT = /\.(txt|log|conf|cfg|ini|env|json|ya?ml|toml|md|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|sql|xml|html?|css|scss|less|go|rs|java|rb|php|pl|lua|c|h|cpp|hpp|service|rules|properties|pem|pub|gitignore|dockerignore|editorconfig)$/i;

function iconFor(e: FileEntry) {
  if (e.type === 'dir') return <Folder size={16} color="var(--accent)" />;
  if (e.type === 'link') return <Link2 size={16} color="var(--purple)" />;
  if (e.type === 'special') return <HardDrive size={16} className="dim" />;
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(e.name)) return <ImageIcon size={16} color="var(--green)" />;
  if (/\.(sh|bash|py|js|ts|mjs|go|rs|rb|pl|lua|sql|ya?ml|json|xml|html?|css)$/i.test(e.name)) return <FileCode size={16} color="var(--yellow)" />;
  if (TEXT_EXT.test(e.name) || e.name.startsWith('.')) return <FileText size={16} color="var(--text-2)" />;
  return <File size={16} className="dim" />;
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function FileBrowser({ active }: { active: boolean }) {
  const files = useFilesApi();
  const { toast, confirm } = useFeedback();

  const [mountList, setMountList] = useState<FileMount[] | null>(null);
  const [mount, setMount] = useState<string>('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<{ mount: string; path: string } | null>(null);
  const [canWrite, setCanWrite] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (m: string, p: string) => {
      setLoading(true);
      setError('');
      try {
        const r = await files.list(m, p);
        setEntries(r.entries);
        setSelected(new Set());
      } catch (e) {
        setEntries([]);
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [files],
  );

  // Load mounts once, then the first browsable one
  const mountsRequested = useRef(false);
  useEffect(() => {
    if (!active || mountsRequested.current) return;
    mountsRequested.current = true;
    files
      .loadMounts()
      .then((m) => {
        setMountList(m.mounts);
        setCanWrite(m.canWrite);
        const first = m.mounts.find((x) => x.browsable);
        if (first) {
          setMount(first.target);
          load(first.target, '');
        }
      })
      .catch((e) => setError((e as Error).message));
  }, [active, files, load]);

  const current = mountList?.find((m) => m.target === mount);
  const writable = canWrite && !!current?.rw;

  const enter = (e: FileEntry) => {
    if (e.type !== 'dir') return;
    const next = path ? `${path}/${e.name}` : e.name;
    setPath(next);
    load(mount, next);
  };

  const goUp = () => {
    const next = parentOf(path);
    setPath(next);
    load(mount, next);
  };

  const refresh = () => load(mount, path);

  const onSelectMount = (target: string) => {
    setMount(target);
    setPath('');
    setQuery('');
    load(target, '');
  };

  const remove = async (list: FileEntry[]) => {
    const names = list.map((e) => e.name);
    const dirs = list.filter((e) => e.type === 'dir');
    const opts = dirs.length
      ? [{ key: 'recursive', label: `递归删除目录及其内容（${dirs.map((d) => d.name).join('、')}）` }]
      : undefined;
    const r = await confirm({
      title: `删除${list.length > 1 ? ` ${list.length} 个条目` : ` ${names[0]}`}？`,
      message: `文件将从容器挂载的宿主机目录中永久删除，无法恢复。`,
      items: list.length > 1 ? names : undefined,
      confirmText: '删除',
      danger: true,
      options: opts,
    });
    if (!r) return;
    const recursive = !!(r as Record<string, boolean>).recursive;
    let failed = 0;
    for (const e of list) {
      const p = path ? `${path}/${e.name}` : e.name;
      try {
        await files.remove(mount, p, recursive);
      } catch (err) {
        failed++;
        toast('error', `删除失败：${e.name}`, (err as Error).message);
      }
    }
    if (!failed) toast('success', '已删除', names.join('、'));
    refresh();
  };

  const mkdir = async () => {
    const name = window.prompt('新建目录名称');
    if (!name) return;
    const clean = name.trim().replace(/^\/+|\/+$/g, '');
    if (!clean || clean.includes('..')) return;
    try {
      await files.mkdir(mount, path ? `${path}/${clean}` : clean);
      toast('success', '已创建目录', clean);
      refresh();
    } catch (e) {
      toast('error', '创建失败', (e as Error).message);
    }
  };

  const rename = async (e: FileEntry) => {
    const to = window.prompt(`重命名为`, e.name);
    if (!to || to === e.name) return;
    const clean = to.trim().replace(/^\/+/, '');
    if (clean.includes('..')) return;
    try {
      await files.rename(mount, path ? `${path}/${e.name}` : e.name, path ? `${path}/${clean}` : clean);
      toast('success', '已重命名', `${e.name} → ${clean}`);
      refresh();
    } catch (err) {
      toast('error', '重命名失败', (err as Error).message);
    }
  };

  const chmod = async (e: FileEntry) => {
    const mode = window.prompt(`${e.name} 的权限（八进制）`, e.mode.toString(8).padStart(4, '0'));
    if (!mode) return;
    try {
      await files.chmod(mount, path ? `${path}/${e.name}` : e.name, mode.trim());
      toast('success', '权限已修改', `${e.name} → ${mode}`);
      refresh();
    } catch (err) {
      toast('error', '修改失败', (err as Error).message);
    }
  };

  const upload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    for (const f of Array.from(fileList)) {
      try {
        const res = await fetch(files.uploadUrl(mount, path, f.name), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: f,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        toast('success', '上传成功', `${f.name}（${formatBytes(f.size)}）`);
      } catch (e) {
        toast('error', `上传失败：${f.name}`, (e as Error).message);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
    refresh();
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (entries || []).filter((e) => !q || e.name.toLowerCase().includes(q));
    return list.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  }, [entries, query]);

  const selectedEntries = (entries || []).filter((e) => selected.has(e.name));

  /* ------------------------------------------------------------- no mounts */
  if (mountList && mountList.length === 0) {
    return (
      <div className="tab-scroll">
        <div className="card empty">
          <HardDrive size={30} />
          <h4>这个容器没有挂载目录</h4>
          <div>文件管理只能操作挂载到宿主机的目录（bind mount）。需要修改容器内部文件时，可以使用「终端」。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="files">
      <div className="console-bar">
        <select className="select sm" value={mount} onChange={(e) => onSelectMount(e.target.value)}>
          {(mountList || []).map((m) => (
            <option key={m.target} value={m.target} disabled={!m.browsable}>
              {m.target} {m.browsable ? (m.rw ? '(读写)' : '(只读)') : `— 数据卷 ${m.name}`}
            </option>
          ))}
        </select>
        <span className="dim mono" style={{ fontSize: 11.5 }}>
          {current?.source}
        </span>
        {current && !current.rw && <span className="tag warn">只读挂载</span>}

        <span className="spacer" />

        <div className="input-icon" style={{ width: 200 }}>
          <Search size={14} />
          <input className="input sm" placeholder="过滤当前目录…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="icon-btn sm clear" style={{ width: 22, height: 22 }} onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>
        {writable && (
          <>
            <button className="icon-btn sm" title="新建目录" onClick={mkdir}>
              <FolderPlus size={15} />
            </button>
            <button className="icon-btn sm" title="上传文件" onClick={() => fileInput.current?.click()}>
              <Upload size={15} />
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          </>
        )}
        <button className="icon-btn sm" title="刷新" onClick={refresh}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="crumbs-bar">
        <button className="icon-btn sm" title="上一级" disabled={!path} onClick={goUp}>
          <ArrowLeft size={15} />
        </button>
        <button className="path-seg" onClick={() => { setPath(''); load(mount, ''); }}>
          {mount || '挂载根目录'}
        </button>
        {path.split('/').filter(Boolean).map((seg, i, arr) => (
          <span key={i} className="row" style={{ gap: 4 }}>
            <ChevronRight size={13} className="dim" />
            <button
              className="path-seg"
              onClick={() => {
                const next = arr.slice(0, i + 1).join('/');
                setPath(next);
                load(mount, next);
              }}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {error && (
        <div className="banner warn" style={{ margin: '10px 24px 0' }}>
          <AlertTriangle size={15} />
          <div>{error}</div>
        </div>
      )}

      <div className="files-body">
        <div className="files-list">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>名称</th>
                <th style={{ width: 110 }}>大小</th>
                <th style={{ width: 150 }}>修改时间</th>
                <th style={{ width: 80 }}>权限</th>
                <th style={{ width: 70 }} className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {!entries &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={6}>
                      <div className="skeleton" style={{ height: 20 }} />
                    </td>
                  </tr>
                ))}
              {entries && visible.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty" style={{ padding: '36px 20px' }}>
                      <Folder size={26} />
                      <h4>{query ? '没有匹配的条目' : '目录为空'}</h4>
                      <div>{query ? '试试其他关键字' : writable ? '可以上传文件或新建目录' : ''}</div>
                    </div>
                  </td>
                </tr>
              )}
              {visible.map((e) => {
                const rel = path ? `${path}/${e.name}` : e.name;
                const isSensitive = SENSITIVE_KEY.test(e.name);
                return (
                  <tr
                    key={e.name}
                    className={`clickable ${open?.path === rel && open.mount === mount ? 'selected' : ''}`}
                    onDoubleClick={() => e.type !== 'dir' && setOpen({ mount, path: rel })}
                    onClick={() => {
                      if (e.type === 'dir') enter(e);
                      else setOpen({ mount, path: rel });
                    }}
                  >
                    <td onClick={(ev) => ev.stopPropagation()}>
                      {writable && e.type !== 'special' ? (
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={selected.has(e.name)}
                            onChange={() =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (n.has(e.name)) n.delete(e.name);
                                else n.add(e.name);
                                return n;
                              })
                            }
                          />
                        </label>
                      ) : null}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 9, minWidth: 0 }}>
                        {iconFor(e)}
                        <span className="truncate" style={{ fontWeight: 500 }}>
                          {e.name}
                        </span>
                        {e.type === 'link' && e.linkTarget && <span className="dim mono" style={{ fontSize: 11.5 }}>→ {e.linkTarget}</span>}
                        {isSensitive && (
                          <span className="tag warn" title="文件名看起来包含敏感信息">
                            <ShieldAlert size={11} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="dim nowrap">{e.type === 'dir' ? '—' : formatBytes(e.size)}</td>
                    <td className="dim nowrap" style={{ fontSize: 12 }}>
                      {e.mtime ? formatDate(e.mtime) : '—'}
                    </td>
                    <td className="mono dim" style={{ fontSize: 12 }}>
                      {e.mode.toString(8).padStart(4, '0')}
                    </td>
                    <td className="col-actions" onClick={(ev) => ev.stopPropagation()}>
                      <span className="row-actions">
                        {e.type !== 'dir' && (
                          <button className="icon-btn sm" title="编辑 / 查看" onClick={() => setOpen({ mount, path: rel })}>
                            <Pencil size={14} />
                          </button>
                        )}
                        <MenuButton
                          title="更多"
                          trigger={<MoreHorizontal size={15} />}
                          items={[
                            {
                              label: '下载',
                              icon: <Download size={15} />,
                              onClick: () => window.open(files.downloadUrl(mount, rel), '_blank'),
                            },
                            { label: '复制路径', icon: <Copy size={15} />, onClick: async () => { await copyText(`${current?.source}/${rel}`); toast('success', '已复制路径'); } },
                            ...(writable
                              ? [
                                  { label: '重命名', icon: <RotateCw size={15} />, onClick: () => rename(e) },
                                  { label: '修改权限', icon: <ShieldAlert size={15} />, onClick: () => chmod(e) },
                                  { label: '', divider: true },
                                  { label: '删除', icon: <Trash2 size={15} />, danger: true, onClick: () => remove([e]) },
                                ]
                              : []),
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {open && (
          <Editor
            key={`${open.mount}/${open.path}`}
            mount={open.mount}
            relPath={open.path}
            readOnly={!canWrite || !mountList?.find((m) => m.target === open.mount)?.rw}
            readOnlyReason={
              !canWrite
                ? '当前为只读模式或文件写入已禁用'
                : `挂载点 ${open.mount} 是只读的（ro）`
            }
            onClose={() => setOpen(null)}
            onSaved={refresh}
          />
        )}
      </div>

      {selectedEntries.length > 0 && (
        <div className="bulkbar">
          <span className="count">已选 {selectedEntries.length} 项</span>
          <button className="btn sm" onClick={() => selectedEntries.filter((e) => e.type !== 'dir').forEach((e) => window.open(files.downloadUrl(mount, path ? `${path}/${e.name}` : e.name), '_blank'))}>
            <Download size={14} /> 下载
          </button>
          <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => remove(selectedEntries)}>
            <Trash2 size={14} /> 删除
          </button>
          <span className="divider" />
          <button className="icon-btn sm" onClick={() => setSelected(new Set())}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

function Editor({
  mount,
  relPath,
  readOnly,
  readOnlyReason,
  onClose,
  onSaved,
}: {
  mount: string;
  relPath: string;
  readOnly: boolean;
  readOnlyReason?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const files = useFilesApi();
  const { toast, confirm } = useFeedback();
  const [loading, setLoading] = useState(true);
  const [binary, setBinary] = useState(false);
  const [disk, setDisk] = useState('');
  const [text, setText] = useState('');
  const [wrap, setWrap] = useState(() => localStorage.getItem('dp-wrap') !== '0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [size, setSize] = useState(0);

  const dirty = text !== disk;
  const name = baseName(relPath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    files
      .read(mount, relPath)
      .then((r) => {
        if (cancelled) return;
        setBinary(r.binary);
        setSize(r.size);
        setDisk(r.content ?? '');
        setText(r.content ?? '');
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [files, mount, relPath]);

  const save = async () => {
    setSaving(true);
    try {
      await files.write(mount, relPath, text);
      setDisk(text);
      toast('success', '已保存', name);
      onSaved();
    } catch (e) {
      toast('error', '保存失败', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !readOnly) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        message: `${name} 的修改尚未保存。`,
        confirmText: '放弃修改',
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  // Ctrl/Cmd+S saves; rebind only when the handler's inputs change (a missing dependency array here would
  // re-run this effect on every keystroke and clobber the edited text).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !readOnly) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="editor">
      <div className="console-bar">
        <FileText size={15} style={{ color: '#7a8596' }} />
        <span className="mono truncate" style={{ fontSize: 12.5 }}>
          {relPath}
        </span>
        {dirty && <span className="dot-unsaved" title="有未保存的修改" />}
        <span className="spacer" />
        {!binary && (
          <button
            className={`icon-btn sm ${wrap ? 'active' : ''}`}
            title="自动换行"
            onClick={() =>
              setWrap((w) => {
                localStorage.setItem('dp-wrap', w ? '0' : '1');
                return !w;
              })
            }
          >
            <WrapText size={14} />
          </button>
        )}
        <button className="icon-btn sm" title="下载" onClick={() => window.open(files.downloadUrl(mount, relPath), '_blank')}>
          <Download size={14} />
        </button>
        <button className="icon-btn sm" title="关闭（未保存的修改会提示）" onClick={close}>
          <X size={15} />
        </button>
      </div>

      <div className="editor-body">
        {loading ? (
          <div className="loading">
            <Loader2 className="spin" size={20} />
          </div>
        ) : binary ? (
          <div className="empty" style={{ padding: '40px 20px' }}>
            <Eye size={26} />
            <h4>二进制文件无法编辑</h4>
            <div>{formatBytes(size)} · 可以下载后使用本地工具处理</div>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => window.open(files.downloadUrl(mount, relPath), '_blank')}>
              <Download size={14} /> 下载
            </button>
          </div>
        ) : (
          <textarea
            className="editor-area"
            spellCheck={false}
            wrap={wrap ? 'soft' : 'off'}
            value={text}
            readOnly={readOnly}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        {error && <div className="banner warn" style={{ margin: 12 }}>{error}</div>}
      </div>

      <div className="console-foot">
        <span>{binary ? '二进制' : `${text.split('\n').length} 行`}</span>
        <span>{formatBytes(new Blob([text]).size)}</span>
        {dirty && <span style={{ color: 'var(--yellow)' }}>未保存</span>}
        <span className="spacer" />
        {readOnly ? (
          <span>{readOnlyReason || '只读，不能保存'}</span>
        ) : (
          <>
            <span>⌘/Ctrl + S 保存</span>
            <button className="btn sm primary" disabled={!dirty || saving} onClick={save}>
              {saving ? <Loader2 size={13} className="spin" /> : dirty ? <Save size={13} /> : <Check size={13} />}
              保存
            </button>
          </>
        )}
      </div>
    </div>
  );
}
