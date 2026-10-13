# Docker 部署方案

前端与后端使用独立镜像，可以分别构建和更新。浏览器仍通过同一个站点访问，前端 Nginx 将 `/api/*` 转发给后端，保持原始 Host 与请求协议，并即时转发生成进度流。模型密钥和数据库配置只注入后端容器。

| 服务 | 镜像 | 内容 / 入口 |
| --- | --- | --- |
| `frontend` | `zhichuang-frontend:latest` | Nginx + `dist/`；本机 `127.0.0.1:4173` |
| `backend` | `zhichuang-backend:latest` | Node 22 API + FreeCAD + 中文字体；内部 `backend:4173` |
| `mysql` | `mysql:8.4` | 沿用 `mysql_data` 持久化卷 |
| `gateway` | `caddy:2-alpine` | 沿用局域网登录入口，转发至 `frontend:80` |

## 文件

- `Dockerfile.frontend`：Node 构建前端，最终镜像只包含 Nginx 和静态产物，不包含 Node、FreeCAD 或服务端密钥。
- `vite.frontend.config.ts`：独立静态构建配置，不加载开发服务的 AI / MySQL 中间件。
- `deploy/nginx.conf`：页面托管及同源 API 代理；支持 96 MB 项目请求体、600 秒代理超时及不缓冲的进度流。Docker DNS 自动解析后端重建后的地址。
- `Dockerfile`：只构建后端，安装生产依赖及 Debian FreeCAD（0.20，含 `freecadcmd`），以非 root 用户运行；保留 API 依赖的共享业务源码，不复制 `dist/`。
- `docker-compose.yml`：前端绑定宿主机 `127.0.0.1:4173`；后端不发布宿主机端口，仅通过内部网络访问。后端内存上限 3 GB，`/tmp` 使用 tmpfs（FreeCAD 临时目录在此，用后即删）。
- `deploy/Caddyfile`：网关转发配置，登录由应用负责。`.env`（项目根，已被 git 忽略）：数据库密码、来源白名单等 compose 插值变量。
- `.dockerignore`：排除 `node_modules`、测试产物、压缩包和 `.env*`。

## 服务端为容器新增的两个环境变量

| 变量 | 作用 |
| --- | --- |
| `HOST` | 监听地址。本机运行默认 `127.0.0.1`；容器内必须 `0.0.0.0`。 |
| `SERVE_FRONTEND` | 后端容器固定为 `false`，只提供 API；本机 `npm start` 默认仍兼容托管 `dist/`。 |
| `ALLOWED_ORIGINS` | 逗号分隔的站点来源白名单（如 `http://127.0.0.1:4173,https://patent.example.com`）。命中时放宽"只接受回环地址"的限制，但仍要求浏览器请求同源（`Origin` / `Sec-Fetch-Site` 检查不变）。经反向代理时按 `X-Forwarded-Proto` 判断 http/https。 |

`FREECAD_CMD`、`FREECAD_TIMEOUT_MS`、`AI_VISION_MODEL` 等与本机一致，见 `.env.example`。

## 启动

```sh
# 1. 准备密钥（与本机相同格式），不要提交到仓库
cp .env.example .env.local   # 填入 AI_API_KEY、AI_IMAGE_API_KEY 等

# 2. 构建并启动（首次构建需下载 FreeCAD 及依赖，约 1–1.5 GB）
docker compose up -d --build

# 3. 查看日志 / 健康状态
docker compose logs -f
docker compose ps
```

打开 `http://127.0.0.1:4173`。项目、命名草稿和资料库文件信息保存到专用 MySQL 容器及 `mysql_data` 卷，刷新和换浏览器可读取同一工作空间。配置、旧数据迁移和完整表字段见 [MySQL 存储](mysql-storage.md)。启动前在 `.env` 中配置 `MYSQL_PASSWORD` 和 `MYSQL_ROOT_PASSWORD`，应用使用专用账号；本机开发的 `.env.local` 使用相同应用密码和 `127.0.0.1:3307`。

从旧版共用镜像迁移时，使用 `docker compose up -d --build --remove-orphans --wait`，移除旧 `zhichuang` 应用容器并释放 4173 端口。MySQL 服务和卷名称保持一致，无需导出再导入数据。不要执行 `docker compose down -v`。

本次迁移也修改了挂载的 Caddy 配置，完成启动后执行 `docker compose up -d --no-deps --force-recreate gateway`，让网关加载新的前端地址。以后修改 `deploy/Caddyfile` 也需重新加载或重建网关。

若 Docker Desktop 在中文目录下启用 Bake 构建时报告 `non-printable ASCII characters`，PowerShell 可先执行 `$env:COMPOSE_BAKE = 'false'`，再运行 Compose 构建命令；也可用下列独立镜像构建命令。

## 验证容器内 FreeCAD

```sh
docker compose exec backend freecadcmd --version
docker compose exec backend sh -c 'printf "import Part\nprint(Part.makeBox(1,1,1).Volume)\n" > /tmp/t.py && freecadcmd /tmp/t.py'
```

应打印版本号和 `1.0`。应用内再跑一次完整流程，确认 CAD 阶段不再返回 `FREECAD_UNAVAILABLE`。

构建前端镜像后，可独立验证 Nginx 代理（自动创建并清理隔离的测试容器，不使用真实模型额度或数据库）：

```sh
node --test tests/docker-proxy.test.mjs
```

该测试覆盖 Host / HTTPS 协议和同源信息、查询参数、大请求体、HTTP 409 转发与 NDJSON 进度实时输出。

## 局域网发布（gateway 网关）

`docker compose up -d` 会同时起 `gateway` 容器（Caddy），它是唯一的对外入口：

- 只绑局域网网卡 `192.168.0.58:80`，只有本网段能连到；该地址是私有地址，公网没有路由就不会暴露。
- 使用应用内登录 / 注册页面，业务接口由服务端登录会话校验。
- 鉴权后转发到前端 `frontend:80`，API 再由 Nginx 转发至 `backend:4173`；前端自身仍只绑宿主机回环，仅本机调试用。

访问地址 `http://192.168.0.58/`。账号在应用注册页面创建，密码以加盐哈希保存到 MySQL。

### 应用账号

登录页可自行注册账号，所有注册用户都是普通用户。登录状态由 MySQL 会话保存，退出登录在右上角账号菜单中完成。字段说明见 [登录和注册](auth.md)。

### 本机 IP 变化

`docker-compose.yml` 里 gateway 的 `ports` 写死了 `192.168.0.58:80:80`。IP 变了要同步改这一行，
并更新 `.env` 的 `ALLOWED_ORIGINS`，然后 `docker compose up -d`。建议在路由器上给本机做 DHCP 保留。

本机 Windows 防火墙三个配置文件目前都是关闭状态，所以没有额外规则拦 80 端口；若以后启用防火墙，需为 80 端口放行本网段。

### 为什么不用 remote_ip 限制来源网段

网关跑在 Docker Desktop 里，端口转发会把客户端来源 IP 统一改写成 docker 网桥地址。实测宿主机访问、
局域网 IP 访问、其他容器访问三条路径，容器内看到的都是 `172.17.0.1`。因此 Caddy 的 `remote_ip`
匹配无法区分内外网来源，网段限制只能靠绑定局域网网卡实现。

### 对外开放到公网

当前方案不含公网入口。确实需要时：

1. 在路由器上把公网端口映射到 `192.168.0.58:80`，或改用内网穿透隧道。
2. gateway 的 `ports` 改成 `80:80`，`SITE_ADDRESS` 改成域名，让 Caddy 自动申请 Let's Encrypt 证书。
3. 换掉弱口令，并确认 `.env` 的 `ALLOWED_ORIGINS` 加上公网来源。

生图与 CAD 都是付费和耗 CPU 的操作，裸露公网前务必先做这三点。

## 资源与并发

- 服务端同一时间最多保留 10 个完整专利生成任务，第 11 个起按提交顺序排队。产品流程通过生成令牌绑定全部步骤，等待预览确认时仍保留名额；完成、失败、取消或离开页面释放名额，不让新任务在步骤之间插队。浏览器每 30 秒续约，页面异常关闭后，空闲名额在停止续约约 90–120 秒后回收。新版文档 V2 的后台任务也占用名额直到整个生成流程结束。队列与令牌位于当前单后端进程内，重启后需重新提交；扩展多副本时需共享调度存储。
- 去除原来每分钟 8/24 次的全局生成限制，避免 10 个正常生成任务被步骤数量误拦截。排队期间页面显示队列位置，可以取消；模型阶段的超时从取得名额后开始。
- CAD 阶段每次起一个 `freecadcmd` 子进程，超过 `FREECAD_TIMEOUT_MS`（默认 300 秒）整棵进程树被强杀。10 个名额是应用调度上限，实际速度与稳定性仍受模型服务商额度、CPU 和内存影响。
- 投影渲染在 Node 内完成，1400×1000 深度缓冲约 6 MB；复杂模型（上限 20 万三角面）单张视图约 1–3 秒。
- 内存上限 3 GB 足够 FreeCAD 处理常规产品模型；如模型复杂导致 OOM，提高 `deploy.resources.limits.memory`。

## 更新

```sh
# 只更新前端（不重建或重启后端 / MySQL）
docker compose build frontend
docker compose up -d --no-deps frontend

# 只更新后端（不重建前端）
docker compose build backend
docker compose up -d --no-deps backend

# 全部更新
docker compose up -d --build

# 脱离 Compose 单独构建镜像
docker build -f Dockerfile.frontend -t zhichuang-frontend:latest .
docker build -f Dockerfile -t zhichuang-backend:latest .
```

更换密钥只需改 `.env.local` 后 `docker compose up -d --no-deps backend`（重建容器即可，不用重新构建镜像）。签名密钥变化会使浏览器里旧的确认凭据失效，页面提供"从逻辑校验重新生成"。

## 不在方案内的事

- 账号和工作空间数据相互隔离，尚未提供角色权限管理；数据库卷需单独备份。
- 镜像用 Debian 的 FreeCAD 0.20，比本机 1.1 旧；脚本只用 `Part` 基本体与布尔运算，两版本行为一致，但若将来提示词放开更多 API，要在容器里回归一次。
