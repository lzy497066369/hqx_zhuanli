# Docker 部署方案

一个镜像同时包含：构建好的前端 `dist/`、本机 AI 服务（Node 22，`server/index.ts`）、无界面 FreeCAD（`freecadcmd`）和中文字体（附图标号在浏览器端栅格化，容器内字体只影响 FreeCAD 自身）。密钥通过 `env_file` 从宿主机 `.env.local` 注入，不进镜像。

## 文件

- `Dockerfile`：两阶段构建。阶段 1 用 `node:22-bookworm` 跑 `npm run build`；阶段 2 安装 Debian 自带的 `freecad`（0.20，含 `freecadcmd`），只装生产依赖，以非 root 用户运行。
- `docker-compose.yml`：端口只绑到宿主机 `127.0.0.1:4173`，内存上限 3 GB，`/tmp` 使用 tmpfs（FreeCAD 临时目录在此，用后即删）。
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

## 对外发布（可选）

默认只绑定宿主机回环地址。要给局域网或公网使用：

1. 在宿主机放一层反向代理（Caddy / Nginx）做 HTTPS，把 `https://你的域名` 转发到 `127.0.0.1:4173`，并转发 `X-Forwarded-Proto`。
2. `ALLOWED_ORIGINS` 改为 `https://你的域名`。
3. **必须**在代理层加鉴权（Basic Auth / OIDC 等）。服务端目前只有同源检查和本进程内的并发/频率限制，没有账户体系；生图与 CAD 都是付费和耗 CPU 的操作，不能裸露公网。

Caddy 示例：

```
patent.example.com {
    basicauth {
        admin $2a$14$替换成caddy_hash_password生成的哈希
    }
    reverse_proxy 127.0.0.1:4173
}
```

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
