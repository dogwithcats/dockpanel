import { Cloud, Copy, KeyRound, Monitor, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFeedback } from '../components/Feedback';
import { HostForm } from '../components/HostForm';
import { hostDotColor, Topbar } from '../components/Layout';
import { MenuButton } from '../components/Menu';
import { api } from '../lib/api';
import { copyText, formatBytes, timeAgo } from '../lib/format';
import { useHosts, useSession } from '../lib/hooks';
import type { Host } from '../lib/types';

const TYPE_ICON = { ssh: <KeyRound size={16} />, tcp: <Cloud size={16} />, local: <Monitor size={16} /> };
const TYPE_LABEL = { ssh: 'SSH', tcp: 'TCP', local: '本机' };

const SETUP = `# 在目标服务器上执行（以 Ubuntu/CentOS 为例）
sudo useradd -m -s /bin/bash dockpanel
sudo usermod -aG docker dockpanel
sudo mkdir -p /home/dockpanel/.ssh
echo "<面板公钥>" | sudo tee /home/dockpanel/.ssh/authorized_keys
sudo chown -R dockpanel:dockpanel /home/dockpanel/.ssh
sudo chmod 700 /home/dockpanel/.ssh && sudo chmod 600 /home/dockpanel/.ssh/authorized_keys

# 生成面板专用密钥（在任意机器上执行，私钥粘贴到“添加服务器”中）
ssh-keygen -t ed25519 -N "" -C dockpanel -f ./dockpanel_key`;

export function Hosts() {
  const { hosts, refresh } = useHosts();
  const { me } = useSession();
  const { toast, confirm } = useFeedback();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Host | 'new' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const remove = async (h: Host) => {
    const ok = await confirm({
      title: `移除服务器 ${h.name}？`,
      message: '只是从面板中移除连接配置（包括保存的密钥），不会影响服务器上的任何容器。',
      confirmText: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeHost(h.id);
      toast('success', '已移除服务器', h.name);
      refresh();
    } catch (e) {
      toast('error', '移除失败', (e as Error).message);
    }
  };

  const canEdit = !me.readOnly;

  return (
    <>
      <Topbar
        crumbs={[{ label: '服务器管理' }]}
        right={
          <div className="row">
            <button className="btn sm" onClick={reload} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
              刷新
            </button>
            {canEdit && (
              <button className="btn sm primary" onClick={() => setEditing('new')}>
                <Plus size={14} />
                添加服务器
              </button>
            )}
          </div>
        }
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1>服务器管理</h1>
            <p>通过 SSH 或 Docker TLS 端口连接多台服务器，目标服务器只需要安装 Docker，不需要部署任何 agent。</p>
          </div>
        </div>

        {hosts && hosts.length === 0 && (
          <div className="card empty" style={{ marginBottom: 16 }}>
            <Server size={30} />
            <h4>还没有服务器</h4>
            <div>添加第一台服务器开始管理容器</div>
            {canEdit && (
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setEditing('new')}>
                <Plus size={14} /> 添加服务器
              </button>
            )}
          </div>
        )}

        <div className="grid hosts" style={{ marginBottom: 16 }}>
          {hosts?.map((h) => {
            const i = h.status.info;
            const online = h.status.state === 'online';
            return (
              <div key={h.id} className="card host-card" onClick={() => navigate(`/containers?host=${h.id}`)}>
                <div className="head">
                  <div className={`ico ${online ? 'tone-blue' : h.status.state === 'offline' ? 'tone-red' : 'tone-gray'}`}>{TYPE_ICON[h.type]}</div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="title row" style={{ gap: 7 }}>
                      <span className="truncate">{h.name}</span>
                      <span className="host-dot" style={{ background: hostDotColor(h) }} />
                    </div>
                    <div className="addr truncate" title={h.address}>
                      {h.address}
                    </div>
                  </div>
                  <span onClick={(e) => e.stopPropagation()}>
                    <MenuButton
                      title="更多"
                      trigger={<MoreHorizontal size={16} />}
                      items={[
                        ...(canEdit ? [{ label: '编辑', icon: <Pencil size={15} />, onClick: () => setEditing(h) }] : []),
                        {
                          label: '复制连接地址',
                          icon: <Copy size={15} />,
                          onClick: async () => {
                            await copyText(h.address);
                            toast('success', '已复制', h.address);
                          },
                        },
                        ...(canEdit
                          ? [
                              { label: '', divider: true },
                              { label: '移除服务器', icon: <Trash2 size={15} />, danger: true, onClick: () => remove(h) },
                            ]
                          : []),
                      ]}
                    />
                  </span>
                </div>

                {online && i ? (
                  <>
                    <div className="nums">
                      <div>
                        <b>
                          {i.running}
                          <span className="dim" style={{ fontSize: 13, fontWeight: 500 }}>
                            /{i.containers}
                          </span>
                        </b>
                        运行中
                      </div>
                      <div>
                        <b>{i.cpus}</b>核 CPU
                      </div>
                      <div>
                        <b>{formatBytes(i.memTotal, 0)}</b>内存
                      </div>
                      <div>
                        <b>{i.images}</b>镜像
                      </div>
                    </div>
                    <div className="dim" style={{ fontSize: 12 }}>
                      {TYPE_LABEL[h.type]} · Docker {i.serverVersion} · {i.os} · {h.status.latency}ms
                    </div>
                  </>
                ) : h.status.state === 'offline' ? (
                  <div className="err">{h.status.error}</div>
                ) : (
                  <div className="skeleton" style={{ height: 42 }} />
                )}
                {h.hostKey && (
                  <div className="dim mono truncate" style={{ fontSize: 11 }} title="SSH 主机指纹（首次连接时记录）">
                    🔒 {h.hostKey}
                  </div>
                )}
                {h.status.checkedAt && (
                  <div className="dim" style={{ fontSize: 11, marginTop: -6 }}>
                    检测于 {timeAgo(h.status.checkedAt)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="card-head">
            <KeyRound size={15} className="dim" />
            <h3>如何准备一台 SSH 服务器</h3>
            <span className="hint">推荐为面板创建专用用户和密钥</span>
            <span className="spacer" />
            <button
              className="btn ghost sm"
              onClick={async () => {
                await copyText(SETUP);
                toast('success', '已复制命令');
              }}
            >
              <Copy size={14} /> 复制
            </button>
          </div>
          <div className="card-body">
            <pre className="code">{SETUP}</pre>
            <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>
              面板通过 SSH 执行 <span className="mono">docker system dial-stdio</span> 访问远程 Docker（与{' '}
              <span className="mono">docker -H ssh://…</span> 相同），不需要开放 Docker 端口。首次连接会记录服务器的 SSH 指纹，之后指纹变化会拒绝连接，防止中间人攻击。
            </div>
          </div>
        </div>
      </div>

      {editing && (
        <HostForm
          host={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(h) => {
            setEditing(null);
            toast(
              h.status.state === 'online' ? 'success' : 'error',
              editing === 'new' ? '已添加服务器' : '已保存',
              h.status.state === 'online' ? h.name : `${h.name}：${h.status.error}`,
            );
            refresh();
          }}
        />
      )}
    </>
  );
}
