# Docker 部署方案

一个镜像同时包含：构建好的前端 `dist/`、本机 AI 服务（Node 22，`server/index.ts`）、无界面 FreeCAD（`freecadcmd`）和中文字体（附图标号在浏览器端栅格化，容器内字体只影响 FreeCAD 自身）。密钥通过 `env_file` 从宿主机 `.env.local` 注入，不进镜像。

## 文件

- `Dockerfile`：两阶段构建。阶段 1 用 `node:22-bookworm` 跑 `npm run build`；阶段 2 安装 Debian 自带的 `freecad`（0.20，含 `freecadcmd`），只装生产依赖，以非 root 用户运行。
- `docker-compose.yml`：应用容器只绑宿主机 `127.0.0.1:4173`；另起 `gateway`（Caddy）绑局域网网卡 `192.168.0.58:80`，做账号鉴权后转发。内存上限 3 GB，`/tmp` 使用 tmpfs（FreeCAD 临时目录在此，用后即删）。
- `deploy/Caddyfile`：网关配置。`.env`（项目根，已被 git 忽略）：网关账号、来源白名单等 compose 插值变量。
- `.dockerignore`：排除 `node_modules`、测试产物、压缩包和 `.env*`。

## 服务端为容器新增的两个环境变量

| 变量 | 作用 |
| --- | --- |
| `HOST` | 监听地址。本机运行默认 `127.0.0.1`；容器内必须 `0.0.0.0`。 |
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

打开 `http://127.0.0.1:4173`。项目数据仍保存在**浏览器** IndexedDB，不在容器内；容器重建不会丢数据，但换浏览器或清站点数据会丢。

## 验证容器内 FreeCAD

```sh
docker compose exec zhichuang freecadcmd --version
docker compose exec zhichuang sh -c 'printf "import Part\nprint(Part.makeBox(1,1,1).Volume)\n" > /tmp/t.py && freecadcmd /tmp/t.py'
```

应打印版本号和 `1.0`。应用内再跑一次完整流程，确认 CAD 阶段不再返回 `FREECAD_UNAVAILABLE`。

## 局域网发布（gateway 网关）

`docker compose up -d` 会同时起 `gateway` 容器（Caddy），它是唯一的对外入口：

- 只绑局域网网卡 `192.168.0.58:80`，只有本网段能连到；该地址是私有地址，公网没有路由就不会暴露。
- 进入前必须通过 Basic Auth，账号来自 `.env` 的 `BASIC_AUTH_USER` / `BASIC_AUTH_HASH`。
- 鉴权后转发到应用容器 `zhichuang:4173`；应用容器自身仍只绑宿主机回环，仅本机调试用。

访问地址 `http://192.168.0.58/`。登录账号与口令由本机管理员配置，凭据保存在被 Git 忽略的本机环境文件中。

### 换账号口令

```sh
docker run --rm caddy:2-alpine caddy hash-password --plaintext '新口令'
```

把输出填回 `.env` 的 `BASIC_AUTH_HASH`（哈希里的 `$` 必须写成 `$$`），再重启网关：

```sh
docker compose up -d gateway
```

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

- 服务端同一时间最多处理 3 个生成任务；CAD 阶段每次起一个 `freecadcmd` 子进程，超过 `FREECAD_TIMEOUT_MS`（默认 300 秒）整棵进程树被强杀。
- 投影渲染在 Node 内完成，1400×1000 深度缓冲约 6 MB；复杂模型（上限 20 万三角面）单张视图约 1–3 秒。
- 内存上限 3 GB 足够 FreeCAD 处理常规产品模型；如模型复杂导致 OOM，提高 `deploy.resources.limits.memory`。

## 更新

```sh
git pull
docker compose up -d --build
```

更换密钥只需改 `.env.local` 后 `docker compose up -d`（重建容器即可，不用重新构建镜像）。签名密钥变化会使浏览器里旧的确认凭据失效，页面提供"从逻辑校验重新生成"。

## 不在方案内的事

- 浏览器数据不做服务端持久化；需要多人共用或备份时要另做账户与存储。
- 镜像用 Debian 的 FreeCAD 0.20，比本机 1.1 旧；脚本只用 `Part` 基本体与布尔运算，两版本行为一致，但若将来提示词放开更多 API，要在容器里回归一次。
