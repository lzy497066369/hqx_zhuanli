# 项目协作约定

- 用户会在代码更新完毕后明确要求重新部署；收到要求后，直接完成构建、更新容器和验证，并报告结果。
- 部署操作先阅读 `docs/redeploy-runbook.md`。这是本机 Windows Docker Desktop 部署，项目根目录就是 Compose 工作目录，不需要 SSH 或推送镜像仓库。
- `.env`、`.env.local` 都在项目根目录。保留现有值，只修改用户要求的配置；不要用 `.env.example` 覆盖真实配置，不输出密钥或完整的 `docker compose config` / 容器环境变量。
- 默认发布当前工作区代码，包括尚未提交的修改；保留已有修改，不为了部署切换分支、重置文件或自动提交。
- 普通重新部署保留 MySQL 和 CAD 持久卷，不执行 `docker compose down -v`、清卷或全局清理。构建成功后再替换应用容器，保存旧镜像的回退标签。
