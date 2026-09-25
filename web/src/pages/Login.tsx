import { AlertCircle, Container, Loader2, Lock, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(username, password);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand-mark">
          <Container size={21} strokeWidth={2.3} />
        </div>
        <h2>登录 DockPanel</h2>
        <p>服务器容器管理控制台</p>

        {error && (
          <div className="form-error">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        <div className="field">
          <label htmlFor="u">用户名</label>
          <div className="input-icon">
            <User size={15} />
            <input id="u" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="p">密码</label>
          <div className="input-icon">
            <Lock size={15} />
            <input
              id="p"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
        </div>
        <button className="btn primary block" style={{ height: 38, marginTop: 6 }} disabled={loading || !password}>
          {loading && <Loader2 size={15} className="spin" />}
          登录
        </button>
        <div className="login-foot">连续失败 5 次将锁定 5 分钟 · 所有操作均会记录审计日志</div>
      </form>
    </div>
  );
}
