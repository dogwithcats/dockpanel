import { AlertCircle, CheckCircle2, Cloud, KeyRound, Loader2, Lock, Monitor, PlugZap, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import type { Host, HostInput, HostTestResult, HostType } from '../lib/types';

const TYPES: { key: HostType; title: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'ssh', title: 'SSH', desc: '推荐 · 远程服务器无需额外配置', icon: <KeyRound size={14} /> },
  { key: 'tcp', title: 'TCP + TLS', desc: 'Docker API 远程端口', icon: <Cloud size={14} /> },
  { key: 'local', title: '本机', desc: '面板所在服务器', icon: <Monitor size={14} /> },
];

function initial(h?: Host): HostInput {
  if (!h) return { name: '', type: 'ssh', port: 22, username: 'root', authMethod: 'key', tls: true };
  return {
    name: h.name,
    type: h.type,
    socketPath: h.socketPath,
    host: h.host,
    port: h.port,
    username: h.username,
    authMethod: h.authMethod ?? 'key',
    tls: h.tls ?? true,
  };
}

export function HostForm({ host, onClose, onSaved }: { host?: Host; onClose: () => void; onSaved: (h: Host) => void }) {
  const editing = !!host;
  const [f, setF] = useState<HostInput>(() => initial(host));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: true; data: HostTestResult } | { ok: false; error: string } | null>(null);
  const [error, setError] = useState('');

  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setResult(null);
    setError('');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const payload = (): HostInput => ({ ...f, id: host?.id, port: f.port ? Number(f.port) : undefined });

  const test = async () => {
    setTesting(true);
    setResult(null);
    setError('');
    try {
      setResult({ ok: true, data: await api.testHost(payload()) });
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const saved = host ? await api.updateHost(host.id, payload()) : await api.addHost(payload());
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const secretHint = (has?: boolean) => (editing && has ? '已保存，留空表示不修改' : undefined);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{editing ? `编辑服务器 · ${host.name}` : '添加服务器'}</h3>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-scroll">
          <div className="type-cards">
            {TYPES.map((t) => (
              <button key={t.key} type="button" className={`type-card ${f.type === t.key ? 'active' : ''}`} onClick={() => set('type', t.key)}>
                <span className="t">
                  {t.icon}
                  {t.title}
                </span>
                <span className="d">{t.desc}</span>
              </button>
            ))}
          </div>

          <div className="field">
            <label>
              名称<span className="req">*</span>
            </label>
            <input className="input" value={f.name} placeholder="例如 prod-web-01" onChange={(e) => set('name', e.target.value)} autoFocus />
          </div>

          {f.type === 'local' && (
            <div className="field">
              <label>Docker Socket 路径</label>
              <input
                className="input mono"
                value={f.socketPath ?? ''}
                placeholder="/var/run/docker.sock"
                onChange={(e) => set('socketPath', e.target.value)}
              />
              <span className="hint">容器方式部署面板时，需要把宿主机的 docker.sock 挂载进来</span>
            </div>
          )}

          {f.type !== 'local' && (
            <div className="form-row">
              <div className="field">
                <label>
                  主机地址<span className="req">*</span>
                </label>
                <input className="input mono" value={f.host ?? ''} placeholder="10.0.0.12 或 web01.example.com" onChange={(e) => set('host', e.target.value)} />
              </div>
              <div className="field">
                <label>{f.type === 'ssh' ? 'SSH 端口' : 'Docker 端口'}</label>
                <input
                  className="input mono"
                  inputMode="numeric"
                  value={f.port ?? ''}
                  placeholder={f.type === 'ssh' ? '22' : f.tls ? '2376' : '2375'}
                  onChange={(e) => set('port', e.target.value.replace(/\D/g, '') as unknown as number)}
                />
              </div>
            </div>
          )}

          {f.type === 'ssh' && (
            <>
              <div className="form-row">
                <div className="field">
                  <label>用户名</label>
                  <input className="input mono" value={f.username ?? ''} placeholder="root" onChange={(e) => set('username', e.target.value)} />
                  <span className="hint">该用户需要能执行 docker 命令（root 或在 docker 组中）</span>
                </div>
                <div className="field">
                  <label>认证方式</label>
                  <div className="segmented" style={{ alignSelf: 'flex-start' }}>
                    <button type="button" className={f.authMethod === 'key' ? 'active' : ''} onClick={() => set('authMethod', 'key')}>
                      私钥
                    </button>
                    <button type="button" className={f.authMethod === 'password' ? 'active' : ''} onClick={() => set('authMethod', 'password')}>
                      密码
                    </button>
                  </div>
                </div>
              </div>

              {f.authMethod === 'key' ? (
                <>
                  <div className="field">
                    <label>
                      私钥{!(editing && host.hasPrivateKey) && <span className="req">*</span>}
                    </label>
                    <textarea
                      className="textarea"
                      spellCheck={false}
                      value={f.privateKey ?? ''}
                      placeholder={secretHint(host?.hasPrivateKey) || '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
                      onChange={(e) => set('privateKey', e.target.value)}
                    />
                    <span className="hint">
                      粘贴 ~/.ssh/id_ed25519 或 id_rsa 的内容。建议为面板单独生成一对密钥，并把公钥加入服务器的 authorized_keys
                    </span>
                  </div>
                  <div className="field">
                    <label>私钥口令</label>
                    <input
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      value={f.passphrase ?? ''}
                      placeholder={secretHint(host?.hasPassphrase) || '私钥未加密则留空'}
                      onChange={(e) => set('passphrase', e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="field">
                  <label>
                    密码{!(editing && host.hasPassword) && <span className="req">*</span>}
                  </label>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={f.password ?? ''}
                    placeholder={secretHint(host?.hasPassword)}
                    onChange={(e) => set('password', e.target.value)}
                  />
                </div>
              )}

              {editing && host.hostKey && (
                <div className="field">
                  <label>主机指纹</label>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <span className="mono muted" style={{ fontSize: 12 }}>
                      {host.hostKey}
                    </span>
                    <label className="check" style={{ fontSize: 12.5 }}>
                      <input type="checkbox" checked={!!f.resetHostKey} onChange={(e) => set('resetHostKey', e.target.checked)} />
                      重置指纹（服务器重装系统或更换 SSH 密钥后使用）
                    </label>
                  </div>
                </div>
              )}
            </>
          )}

          {f.type === 'tcp' && (
            <>
              <div className="field">
                <label className="switch" style={{ fontSize: 13, color: 'var(--text)' }}>
                  <input type="checkbox" checked={f.tls !== false} onChange={(e) => set('tls', e.target.checked)} />
                  <span className="track" />
                  使用 TLS 双向认证
                </label>
              </div>
              {f.tls !== false ? (
                <>
                  {(['ca', 'cert', 'key'] as const).map((k) => (
                    <div className="field" key={k}>
                      <label>
                        {k === 'ca' ? 'CA 证书 (ca.pem)' : k === 'cert' ? '客户端证书 (cert.pem)' : '客户端私钥 (key.pem)'}
                        {!(editing && host.hasCerts) && <span className="req">*</span>}
                      </label>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 70 }}
                        spellCheck={false}
                        value={(f[k] as string) ?? ''}
                        placeholder={secretHint(host?.hasCerts) || `-----BEGIN ${k === 'key' ? 'PRIVATE KEY' : 'CERTIFICATE'}-----`}
                        onChange={(e) => set(k, e.target.value)}
                      />
                    </div>
                  ))}
                </>
              ) : (
                <div className="banner warn" style={{ marginBottom: 14 }}>
                  <ShieldAlert size={16} style={{ flex: 'none', marginTop: 1 }} />
                  <div>
                    未加密的 Docker 端口（2375）相当于把服务器 root 权限暴露在网络上，任何能访问该端口的人都能完全控制服务器。
                    仅限在隔离的内网中使用，建议改用 SSH。
                  </div>
                </div>
              )}
            </>
          )}

          {result &&
            (result.ok ? (
              <div className="test-result ok">
                <CheckCircle2 size={16} style={{ flex: 'none', marginTop: 1 }} />
                <div className="body">
                  连接成功 · <b>{result.data.name}</b> · Docker {result.data.serverVersion} · {result.data.latency}ms
                  <div className="dim">
                    {result.data.os} · {result.data.containers} 个容器（{result.data.running} 个运行中）
                  </div>
                  {result.data.fingerprint && (
                    <div className="dim mono" style={{ fontSize: 11.5, marginTop: 4 }}>
                      <Lock size={11} style={{ verticalAlign: -1 }} /> {result.data.fingerprintIsNew ? '首次连接，保存后将信任此主机指纹：' : '主机指纹：'}
                      {result.data.fingerprint}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="test-result err">
                <AlertCircle size={16} style={{ flex: 'none', marginTop: 1 }} />
                <div>{result.error}</div>
              </div>
            ))}
          {error && (
            <div className="test-result err">
              <AlertCircle size={16} style={{ flex: 'none', marginTop: 1 }} />
              <div>{error}</div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={test} disabled={testing || saving}>
            {testing ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />}
            测试连接
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={saving || testing}>
            {saving && <Loader2 size={14} className="spin" />}
            {editing ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
