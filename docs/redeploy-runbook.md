# 知创工坊重新部署操作手册

2026-10-15 已通过正在运行的容器标签核对部署目录、Docker 上下文、端口和持久卷。用户后续说“重新部署”时，按本文发布当前工作区代码并验证结果。

## 部署位置与访问路径

- 项目根目录：`C:\Users\zyun5\Desktop\知创工坊\知创工坊`
- 运行环境：本机 Docker Desktop，Linux 容器，Docker context 为 `desktop-linux`。
- 编排入口：根目录 `docker-compose.yml`，Compose 项目名固定为 `zhichuang`。
- 本机入口：`http://127.0.0.1:4173/`。
- 局域网入口：`http://192.168.0.58/`，当前绑定 WLAN 的 `192.168.0.58:80`。
- 当前直接在本机构建和运行镜像，无远端服务器、SSH 上传或镜像仓库推送步骤。

请求路径：浏览器 → Caddy `gateway:80` → Nginx `frontend:80` → `/api/*` 转发至 `backend:4173` → MySQL `mysql:3306`。本机入口直接进入前端 Nginx。

| 服务 / 容器 | 镜像 | 构建及数据来源 |
| --- | --- | --- |
| `frontend` / `zhichuang-frontend` | `zhichuang-frontend:latest` | `Dockerfile.frontend`，容器内编译 TypeScript 和 Vite，产物交给 Nginx |
| `backend` / `zhichuang-backend` | `zhichuang-backend:latest` | `Dockerfile`，Node 22 + FreeCAD + `server/` 和共享 `src/` 源码 |
| `mysql` / `zhichuang-mysql` | `mysql:8.4` | 数据卷 `zhichuang_mysql_data`；宿主机数据库端口 `127.0.0.1:3307` |
| `gateway` / `zhichuang-gateway` | `caddy:2-alpine` | 挂载 `deploy/Caddyfile`，对外发布局域网 80 端口 |

后端 CAD 检查点保存在 `zhichuang_cad_checkpoints`；网关另有 `zhichuang_caddy_data`、`zhichuang_caddy_config`。常规更新保留这些卷。应用镜像包含构建时的源码，宿主机改完代码后要重建对应镜像才能发布；本机 `dist/` 不用于这两套镜像的构建。

## 根目录环境文件

| 文件 | 用途 | 如何生效 |
| --- | --- | --- |
| `.env` | Compose 插值：数据库账号密码、宿主机数据库端口、`ALLOWED_ORIGINS`、`SITE_ADDRESS` 等 | Compose 读取，再写入相应服务配置；更新受影响的容器 |
| `.env.local` | 后端 `env_file`：模型地址、密钥、模型名及本机开发数据库配置 | 创建后端容器时注入；修改后需要重新创建后端容器 |
| `.env.example` | 配置格式参考 | 不用于覆盖现有真实配置 |

Compose 的 `backend.environment` 优先于 `.env.local`：容器内数据库固定连接 `mysql:3306`，而 `.env.local` 的 `127.0.0.1:3307` 用于宿主机开发。`.env` 不会整份自动注入后端。`.dockerignore` 排除了 `.env*`，密钥不进入镜像。

生图模型由 `.env.local` 的 `AI_IMAGE_MODEL` 控制。每次部署以根目录的当前配置为准，不用过去的临时模型设置覆盖它；部署后核对容器实际生效值。仅 `docker compose restart backend` 不会重新读取环境文件。

## 常规代码重新部署（PowerShell）

1. 在项目根目录确认 Docker 可用、当前改动和 Compose 配置；只输出配置校验结果，避免泄露密钥。

```powershell
Set-Location -LiteralPath 'C:\Users\zyun5\Desktop\知创工坊\知创工坊'
docker context show
git status --short --branch
docker compose config --quiet
docker compose ps
```

2. 保存当前运行镜像，便于回退。在构建前记录容器 ID、镜像 ID 和健康状态。每条命令成功后再继续；PowerShell 外部命令失败时需检查 `$LASTEXITCODE`。

```powershell
$releaseStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$oldBackendImage = docker inspect zhichuang-backend --format '{{.Image}}'
$oldFrontendImage = docker inspect zhichuang-frontend --format '{{.Image}}'
docker image tag $oldBackendImage "zhichuang-backend:rollback-$releaseStamp"
docker image tag $oldFrontendImage "zhichuang-frontend:rollback-$releaseStamp"
```

3. 先构建两个应用镜像，全部成功后再替换容器。中文目录下关闭 Compose Bake，避免路径编码错误。镜像构建过程中旧服务继续运行。

```powershell
$env:COMPOSE_BAKE = 'false'
$env:DOCKER_BUILDKIT = '0'
docker compose build frontend backend
docker compose up -d --no-deps --wait --wait-timeout 180 backend
docker compose up -d --no-deps --wait --wait-timeout 180 frontend
```

代码未提交也可以部署；不需要先 `git pull` 或创建提交。`src/` 同时被前后端使用，无法明确判断影响范围时构建两者。常规更新不重建 MySQL 和网关。后端重建会中断当前进程内的生成任务和队列，进行中的任务需要重新提交。

当前已有镜像由经典构建器生成；`DOCKER_BUILDKIT=0` 可复用本机已有 FreeCAD 层，避免重新下载约 418 MB 的系统依赖。若未来 Docker 移除经典构建器支持，再改用 BuildKit 并重新建立缓存。

若 npm 官方源出现连接中断，可在本次构建中切换下载源：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com frontend backend`。两个 Dockerfile 默认仍使用官方源；构建参数只更改下载来源，不改变 lock 文件的依赖版本与完整性校验。

4. 检查容器、两个入口、API 和生效的模型；将结果写入 `artifacts/redeploy-<时间>/verification.json`，其中只记录非敏感信息。

```powershell
docker compose ps
docker compose logs --since 5m --tail 80 backend frontend gateway
Invoke-RestMethod 'http://127.0.0.1:4173/healthz'
Invoke-RestMethod 'http://127.0.0.1:4173/api/storage/health'
Invoke-RestMethod 'http://127.0.0.1:4173/api/auth/me'
Invoke-RestMethod 'http://192.168.0.58/healthz'
Invoke-RestMethod 'http://192.168.0.58/api/storage/health'
Invoke-RestMethod 'http://192.168.0.58/api/auth/me'
docker compose exec -T backend node -e 'console.log(JSON.stringify({imageModel:process.env.AI_IMAGE_MODEL,textModel:process.env.AI_MODEL}))'
```

前端、后端和 MySQL 应为 `healthy`，网关为 `running`；存储健康接口应返回 `status: ok`、`driver: mysql`。两个首页均应返回 200，首页引用的 JS/CSS 资源也应能读取。登录状态接口在未登录时应正常返回启用鉴权的匿名状态。需要核对容器使用的镜像 ID 与新构建的 `latest` 镜像一致。

模型配置生效与真实模型调用成功分别记录。常规部署验证不自动提交付费生图任务。

## 按更新范围缩小部署

| 改动 | 操作 |
| --- | --- |
| 仅前端 | `docker compose build frontend`，成功后 `docker compose up -d --no-deps --wait frontend` |
| 仅后端 | `docker compose build backend`，成功后 `docker compose up -d --no-deps --wait backend` |
| 仅模型或密钥 | 改 `.env.local` 后 `docker compose up -d --no-deps --force-recreate --wait backend`，无需构建镜像 |
| `deploy/nginx.conf` | 重建并更新前端镜像 |
| `deploy/Caddyfile`、网关环境或端口 | `docker compose up -d --no-deps --force-recreate gateway`，然后验证局域网入口 |
| 本机局域网 IP 改变 | 同步更新 Compose 网关端口绑定、`.env` 的 `ALLOWED_ORIGINS`，更新后端与网关 |

不要通过重新初始化 MySQL 来应用密码变化；数据库已有数据时，账号变更需要单独处理。首次部署和重大基础设施调整参见 [Docker 部署方案](deploy-docker.md)。

## 生图地址被代理 DNS 解析为私网

若多个项目同时报“图片地址解析到非公开网络，已拒绝下载”，先检查后端解析：

```powershell
docker compose exec -T backend node -e "require('node:dns').lookup('image-junliai-org.b-cdn.net',{all:true,family:4},(e,r)=>console.log(e ? e.code : r))"
```

本机 Mihomo 的 fake-ip 模式曾把该 CDN 域名解析为 `10.96.0.8`，触发了图片下载的私网地址防护。在 Clash Verge Rev 的全局覆写文件 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\profiles\Merge.yaml` 中，将以下字段合并进已有的 `dns` 配置，保留原有过滤项并先备份文件：

```yaml
dns:
  fake-ip-filter:
    - image-junliai-org.b-cdn.net
```

通过 Clash Verge Rev 重载配置后，再检查宿主机和后端容器的解析，确认返回公网 IPv4；不要固定某个 CDN IP，也不要放开应用的私网地址校验。覆写文件不提交到仓库。无需重建应用；优先保留后端进程，避免丢失尚未凑齐四张预览的进程内缓存，再由用户重试缺失视图。

## 回退

构建失败时保留正在运行的容器，修复后重试。发布后若验证失败，可将本次保存的旧镜像重新标记为 `latest`，用 `--no-build` 更新对应应用容器：

```powershell
docker image tag "zhichuang-backend:rollback-$releaseStamp" zhichuang-backend:latest
docker image tag "zhichuang-frontend:rollback-$releaseStamp" zhichuang-frontend:latest
docker compose up -d --no-build --no-deps --wait backend
docker compose up -d --no-build --no-deps --wait frontend
```

旧镜像标签不会恢复 `.env.local` 或数据库结构；若本次修改了配置，需同时恢复对应配置值。常规更新不执行 `docker compose down -v`、`docker volume rm` 或全局清理。
