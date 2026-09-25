# DockPanel

轻量的 Docker 容器管理面板：**多服务器**、启停 / 删除、实时日志、Web 终端、资源监控、操作审计。

- 后端：Node.js 22 + Express 5 + dockerode + ws（不依赖数据库）
- 前端：React 19 + Vite + xterm.js，深色 / 浅色主题

## 功能

| 模块 | 说明 |
|---|---|
| 多服务器 | 通过 SSH（推荐）或 Docker TLS 端口管理多台服务器，目标机只需装 Docker，无需 agent；在线状态、延迟实时显示 |
| 概览 | 所有服务器的容器汇总、需要关注的异常容器、服务器状态、Compose 项目 |
| 容器列表 | 跨服务器汇总或按服务器查看；搜索、状态筛选、按服务器 / Compose 项目分组、排序、批量操作（可跨服务器），每 5 秒刷新 |
| 容器操作 | 启动、停止、重启、暂停/恢复、kill、删除（可选强制删除和清理匿名卷），危险操作需要二次确认 |
| 日志 | WebSocket 实时推送；可选行数、时间范围、时间戳；搜索高亮或只显示匹配行；保留 ANSI 颜色，stderr 标红；支持下载 |
| 文件 | 浏览 / 编辑容器挂载到宿主机的目录：在线编辑并保存、上传下载、新建目录、重命名、改权限、删除（目录需要二次确认才递归删除） |
| 终端 | 基于 xterm.js 的交互式 shell，自动选择 bash 或 sh，可指定用户，支持窗口自适应和全屏 |
| 监控 | 实时 CPU、内存、网络、磁盘 I/O，带 60 秒曲线 |
| 配置 | 基本信息、端口、网络、挂载、环境变量（敏感值默认脱敏）、Labels、完整 `docker inspect` |
| 审计 | 记录登录、所有容器操作和终端会话，持久化到 `data/audit.log` |

## 安全设计

挂载 `docker.sock` 等于拥有宿主机 root 权限，所以默认做了以下防护：

- **必须登录**：未设置 `ADMIN_PASSWORD` 时，启动会随机生成密码并打印到日志
- 登录连续失败 5 次，锁定 5 分钟
- 会话 Cookie 设置 `HttpOnly` 和 `SameSite=Strict`，HTTPS 下自动加 `Secure`
- API 和 WebSocket 校验 Origin，防御 CSRF 和跨站 WebSocket 劫持
- 生产环境设置 CSP、X-Frame-Options 等安全响应头
- 带 `dockpanel.protected=true` label 的容器，禁止停止、重启、暂停、kill 和删除（面板默认保护自身）
- `READ_ONLY=true` 只读模式；`ALLOW_EXEC=false` 关闭终端；`ALLOW_FILE_WRITE=false` 让文件管理只能查看
- 文件写入、删除、改权限都会记录到审计日志
- 环境变量里的 password、secret、token、key 等值默认脱敏
- SSH 首次连接记录服务器主机指纹（TOFU），之后指纹变化即拒绝连接，防止中间人攻击
- 服务器私钥/密码保存在 `data/hosts.json`（权限 0600），API 永远不会返回这些字段；请妥善备份和保护该文件

## 部署（推荐 docker compose）

```bash
cp .env.example .env        # 修改 DOCKPANEL_PASSWORD
docker compose up -d --build
```

默认只监听 `127.0.0.1:8080`。对外访问请在前面放一层 HTTPS 反向代理。

### nginx：挂在子路径下（如 `/dockerpanel`）

启动时设置 `BASE_PATH=/dockerpanel`（compose 中为 `.env` 的 `DOCKPANEL_BASE_PATH`），然后：

```nginx
location /dockerpanel/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;       # WebSocket（日志/终端/监控）
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;             # 必需：用于 Origin 校验
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;                        # 长连接日志/终端
    proxy_buffering off;
}
```

完整示例见 [`deploy/nginx-subpath.conf`](deploy/nginx-subpath.conf)。以下 4 种写法都支持（均已实测）：

| location | proxy_pass | 访问 |
|---|---|---|
| `/dockerpanel/` | `http://127.0.0.1:8080` | ✅ |
| `/dockerpanel/` | `http://127.0.0.1:8080/` | ✅ |
| `/dockerpanel` | `http://127.0.0.1:8080` | ✅ |
| `/dockerpanel` | `http://127.0.0.1:8080/` | ✅ |

说明：
- 同一份构建产物可以部署在任意子路径，更换路径只需修改 `BASE_PATH` 并重启，无需重新构建
- 登录 Cookie 的 Path 限定为 `BASE_PATH`，不会与同域名下的其他系统冲突
- 如果浏览器提示“跨站请求被拒绝”，通常是漏了 `proxy_set_header Host $http_host;`，服务端日志会给出具体提示

### nginx：独占域名

同上，把 `location /dockerpanel/` 改为 `location /`，并且不设置 `BASE_PATH`。

## 文件管理

容器详情页的「文件」标签可以浏览和修改**挂载到宿主机的目录**（bind mount）。

实现方式：面板通过 Docker API 临时启动一个轻量容器（默认 `alpine`，可用 `FILE_HELPER_IMAGE` 指定），把同一个宿主机路径挂进去，所有读写都在这个容器里完成，不需要在宿主机上装 agent 或开放文件系统端口。因此这个功能对远程服务器（SSH / TLS）同样可用。

| 能力 | 说明 |
|---|---|
| 浏览 | 显示名称、大小、修改时间、权限；按目录 / 文件排序，可过滤当前目录 |
| 编辑 | 在线编辑文本文件，`⌘/Ctrl + S` 保存；保存采用「先写临时文件再替换」，并保留原文件权限；二进制文件只提示下载不打开编辑器 |
| 上传 / 下载 | 上传单个文件到当前目录；下载单个文件，或把整个目录打包成 tar |
| 管理 | 新建目录、重命名、修改权限（八进制）、删除 |
| 安全 | 路径穿越（`..`）会被拒绝；只读挂载（`ro`）不能写入；删除目录需要确认；面板自身也支持只读模式 |

注意：

- **单文件挂载**（如 `-v ./nginx.conf:/etc/nginx/nginx.conf`）会直接打开这个文件，可以查看、编辑、下载、改权限，不能重命名或删除。保存时原地覆盖，因为挂载进容器的文件无法被替换；宿主机上用 vim / `sed -i` 这类「写新文件再替换」的方式修改后，面板会自动读到新文件，但**应用容器仍然看到旧文件**，需要重启容器才会生效（这是 Docker 单文件挂载本身的限制，挂目录可以避免）
- **数据卷（named volume）不在此功能范围内**，Docker 管理的数据卷无法通过宿主机路径访问，页面会提示改用终端
- 面板对 bind mount 的读写等同于直接操作宿主机文件，请按生产环境的标准保护好面板账号，见[安全设计](#安全设计)
- 大文件建议下载后处理，在线编辑上限为 8 MB

## 自定义 Docker socket 路径

默认使用 `/var/run/docker.sock`。rootless Docker、Podman 或自定义 `dockerd -H` 时可以修改：

- **首次启动前**：设置 `DOCKER_SOCKET=/run/user/1000/docker.sock`（或 `DOCKER_HOST=unix:///…`）
- **已经运行过**：进入「服务器管理」，在本机服务器上点 ⋯ →「编辑」，修改 Socket 路径，点「测试连接」后保存。此时再改环境变量不会生效，启动日志会给出提示

常见路径：

| 场景 | 路径 |
|---|---|
| 标准 Docker | `/var/run/docker.sock` |
| Rootless Docker | `/run/user/<UID>/docker.sock` |
| Podman（root） | `/run/podman/podman.sock` |
| Podman（rootless） | `/run/user/<UID>/podman/podman.sock` |

容器方式部署时，填写的是**容器内**的路径，并且要挂载对应文件，例如：

```yaml
    volumes:
      - /run/user/1000/docker.sock:/var/run/docker.sock   # 宿主机路径:容器内路径
```

这种写法下面板配置保持默认的 `/var/run/docker.sock` 即可。同一台机器上有多个 socket（例如 Docker + Podman）时，可以添加多个「本机」类型的服务器。

## 添加多台服务器

登录后进入 **服务器管理 → 添加服务器**，支持三种连接方式：

| 方式 | 适用场景 | 目标服务器需要 |
|---|---|---|
| **SSH**（推荐） | 绝大多数情况 | 能 SSH 登录、该用户能执行 `docker` 命令 |
| TCP + TLS | 已开启 Docker TLS 端口（2376） | CA / 客户端证书 |
| 本机 | 面板所在服务器 | 挂载 `/var/run/docker.sock` |

SSH 方式的原理和 `docker -H ssh://user@host` 相同：面板通过 SSH 执行 `docker system dial-stdio` 来访问远程 Docker，**不需要开放 Docker 端口，也不需要部署 agent**。面板会复用 SSH 长连接，操作几乎没有额外延迟。

为目标服务器准备一个专用用户（推荐，不要直接用 root）：

```bash
# 在面板所在机器上生成专用密钥
ssh-keygen -t ed25519 -N "" -C dockpanel -f ./dockpanel_key

# 在每台目标服务器上执行
sudo useradd -m -s /bin/bash dockpanel
sudo usermod -aG docker dockpanel
sudo mkdir -p /home/dockpanel/.ssh
cat dockpanel_key.pub | sudo tee /home/dockpanel/.ssh/authorized_keys   # 把公钥内容写进去
sudo chown -R dockpanel:dockpanel /home/dockpanel/.ssh && sudo chmod 700 /home/dockpanel/.ssh
```

然后在面板中填写地址、用户名 `dockpanel`，粘贴 `dockpanel_key`（私钥）的内容，点击「测试连接」确认后添加即可。

> 注意：`docker` 组权限等同于 root，这是 Docker 本身的特性，任何能管理容器的方案都一样。

连接失败时面板会给出具体原因，例如：认证失败、端口被拒绝、远程用户没有 Docker 权限（提示加入 docker 组）、未安装 Docker、主机指纹不匹配、TLS 证书不匹配等。

## 直接运行（不用容器）

```bash
npm ci && npm run build
ADMIN_PASSWORD=xxx npm start      # http://localhost:8080
```

## 开发

```bash
npm install
./test/fixtures.sh                # 创建测试用的容器和挂载目录
ADMIN_PASSWORD=dev npm run dev    # 后端 :8080（--watch） + 前端 Vite :5173（热更新）
```

测试：

```bash
node --test server/                    # 解析等纯函数单测
./test/files-api-test.sh               # 文件管理接口端到端（需要面板正在运行）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_USER` | `admin` | 登录用户名 |
| `ADMIN_PASSWORD` | 随机生成 | 登录密码 |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `BASE_PATH` | – | 子路径部署，如 `/dockerpanel` |
| `SESSION_TTL_HOURS` | `12` | 会话有效期 |
| `TRUST_PROXY` | `false` | 位于反向代理之后时设为 `true` |
| `COOKIE_SECURE` | `false` | 强制使用 Secure Cookie |
| `ALLOWED_ORIGINS` | – | 额外允许的来源（逗号分隔） |
| `READ_ONLY` | `false` | 只读模式 |
| `ALLOW_EXEC` | `true` | 是否允许 Web 终端 |
| `ALLOW_FILE_WRITE` | `true` | 是否允许文件管理写入 / 删除 / 改权限 |
| `FILE_HELPER_IMAGE` | 自动选择 | 文件管理使用的助手镜像，默认从 `alpine` / `busybox` / `debian:stable-slim` / `ubuntu` 中挑一个已存在的 |
| `HOST_LABEL` | `本机` | 首次启动时本机服务器的显示名称（之后可在界面修改） |
| `DATA_DIR` | `./data` | 数据目录：`audit.log` 审计日志、`hosts.json` 服务器列表 |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | 本机 Docker socket 路径，也可用 `DOCKER_HOST=unix:///…`。**仅首次启动生效**，之后在「服务器管理 → 编辑」中修改 |

## 目录结构

```
server/            后端
  index.js         REST API + 静态资源
  ws.js            WebSocket：logs / exec / stats
  auth.js          登录、会话、Origin 校验、失败锁定
  hosts.js         多服务器：连接配置、状态检测、连接测试
  ssh-agent.js     SSH 连接池（docker system dial-stdio）
  docker.js        状态和资源数据计算、错误信息
  files.js         容器文件管理（助手容器 + exec + 归档 API）
  files-routes.js  文件管理 REST 接口
  paths.js         BASE_PATH 子路径处理
  audit.js         审计日志
web/src/
  pages/           Dashboard / Containers / ContainerDetail / Hosts / Audit / Login
  components/      LogViewer、Terminal、StatsPanel、FileBrowser、Feedback（弹窗/Toast）…
  styles.css       设计系统（CSS 变量实现主题）
```

## Roadmap

- [ ] 镜像管理（列表、拉取、删除、清理悬空镜像）
- [ ] 数据卷、网络管理
- [ ] 文件管理支持 named volume（通过 `docker volume` 的挂载点）
- [ ] Compose 项目级操作（整体启停、查看 compose 文件）
- [ ] 通过 Docker events 实时刷新，替代轮询
- [ ] 多用户和角色（管理员 / 运维 / 只读），接入 OIDC/LDAP
- [ ] 容器异常告警（企业微信 / 钉钉 / 飞书 webhook）
- [ ] 终端会话录像回放
