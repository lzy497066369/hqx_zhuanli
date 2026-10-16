# MySQL 存储

应用使用 `mysql2` 连接池，通过同源 `/api/storage/*` 接口保存项目、命名草稿与资料库文件信息。开发服务、生产服务和 Vite 预览均已注册接口。数据库名称默认 `zhichuang`，Docker 使用 MySQL 8.4，中文字符使用 `utf8mb4`。

## 当前本机配置

- Docker 容器：`zhichuang-mysql`。
- 本机连接：`127.0.0.1:3307`；应用容器内连接：`mysql:3306`。
- 数据库 / 应用账号：`zhichuang` / `zhichuang`。
- 随机生成的应用密码保存在被 Git 忽略的 `.env` 和 `.env.local`，root 密码仅保存在 `.env`。
- 持久化卷：`zhichuang_mysql_data`。重建应用容器、数据库容器或重启 Docker 都保留数据。`docker compose down -v` 会删除数据库卷，不用于普通更新。
- 使用账号独立工作空间，一个账号可新建多个，项目 / 草稿 / 资料均隔离。旧共享 `default` 空间保留在库中但不向账号开放，详见 [独立工作空间](workspaces.md)。

## 表与字段

新增账号表 `users`、会话表 `user_sessions` 与 AI 请求审计表 `ai_request_logs`，完整字段与角色规则见 [登录和注册](auth.md)。原有业务 / 结构表继续保留。

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `schema_migrations` | `version`, `name`, `applied_at` | 数据库结构版本和初始化记录 |
| `workspaces` | `id`, `owner_user_id`, `name`, `description`, `projects_revision`, `materials_revision`, `projects_initialized`, `created_at`, `updated_at` | 所属账号、空间名称和简介、项目及资料库版本 |
| `projects` | `workspace_id`, `id`, `name`, `category`, `owner`, `description`, `status`, `is_demo`, `position`, `data`, `created_at`, `updated_at` | 项目基本信息、类别、状态、顺序和完整创作数据 |
| `naming_drafts` | `workspace_id`, `draft_key`, `data`, `revision`, `created_at`, `updated_at` | 企业产品输入、候选名称、结构选择及未确认草稿 |
| `materials` | `workspace_id`, `id`, `name`, `size`, `mime_type`, `last_modified`, `position`, `created_at`, `updated_at` | 资料库文件名称、字节大小、MIME 类型、原文件修改时间和顺序 |

`category` 可为 `invention`（发明）、`utility`（实用新型）、`design`（外观设计）、`software`（软著）。`status` 为 `draft`（草稿）或 `ready`（已整理）。`projects`、`materials` 以 `(workspace_id, id)` 为联合主键，草稿以 `(workspace_id, draft_key)` 为联合主键，工作空间关联均有外键。

`projects.data` 是完整项目 JSON，含应用原有 `updatedAt`、`naming`、`productWorkflow`、`utilityDrawing`、`utilityMaterials`、`inventionFacts`、`inventionMaterials`。其中 `productWorkflow` 保存逻辑审查、产品简介、彩色预览、确认凭据、重画对话、CAD 脚本与 SVG 附图、申请文案及上一版结果；实际图片 data URL 一并保存。列 `updated_at` 是数据库写入时间，JSON 的 `updatedAt` 是应用业务更新时间。

`naming_drafts.data` 保存原有命名记录：`version`、`profile`（`company`, `business`, `product`, `features`, `excludedTerms`, `improvementType`）、`options`、`candidates`、`selectedName`、`confirmed`、`structureOptions`、`structureSelection`。新项目的 `draft_key` 为 `new`，已有项目使用项目 ID。清空草稿保留 JSON `null` 和递增版本，防止旧页面或旧浏览器备份再次恢复已清空草稿。

资料库仅上传并保存文件元信息，**不读取或保存所选文件的内容**。Word 文件仍根据已保存的项目数据按需生成，不单独建表。模板为代码内置配置。

## 启动与更新

Docker 的 `.env` 需配置 `MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_PORT`。本机开发的 `.env.local` 配置 `STORAGE_DRIVER=mysql` 和 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_WORKSPACE_ID`；不要使用 `VITE_` 前缀。

```sh
docker compose up -d mysql
npm run db:migrate
npm run dev -- --host 127.0.0.1

# 完整容器部署 / 更新
docker compose up -d --build
```

表结构位于 `server/mysql/schema.sql`。首次存储访问自动创建表，初始化操作有 MySQL advisory lock，可用 `npm run db:migrate` 单独验证连接和初始化。应用账号由官方 MySQL 镜像首次启动时创建，仅授予应用数据库权限。修改已有卷的密码需要在 MySQL 内执行密码变更，并同步环境配置；只修改 `.env` 不会重置已有数据库账号。

## 旧数据和保存行为

新个人空间为空白，不自动导入浏览器旧数据。旧共享数据库空间和浏览器备份均保留，避免自动分配给错误账号。登录相同账号并选择同一空间，可跨浏览器访问自己的项目。旧资料库原本仅在会话内存在，没有可迁移的历史文件内容。

保存使用事务和版本号；前端串行提交修改，多页面同时保存时过期版本返回 HTTP 409，不覆盖数据库。数据库断连返回脱敏 HTTP 503；页面持续提示未保存状态并提供项目及资料库 JSON 备份，不把失败显示为保存成功。失败后先导出备份，恢复数据库再刷新核对；没有自动合并冲突或 JSON 备份导入功能。

请求体上限 96 MB，数据库包上限 128 MB。数据库 API 仅接受同源 / 允许来源请求，SQL 值均使用参数绑定。浏览器和前端构建产物没有数据库密码。

如需运行历史浏览器存储回归，可显式设置 `STORAGE_DRIVER=indexeddb`；正式配置默认使用 MySQL，不会因数据库故障静默退回浏览器。

## 验证

```sh
npm run lint
npm run build
npm run test:mysql
npx playwright test --config playwright.mysql.config.ts
```

MySQL 专项测试使用临时工作空间并清理测试数据，覆盖实际数据库读写、5 MB 图片、中文与 SQL 特殊字符、参数校验、并发冲突、草稿清空、项目删除、服务重启恢复、来源限制和连接故障。浏览器专项覆盖旧项目迁移、跨浏览器读取、页面刷新、命名草稿和资料库恢复、冲突提示。历史页面与产品流程测试显式使用 IndexedDB，保持场景之间相互隔离。

MySQL 的 JSON 会重排对象键。读取项目时仅对内容完全相同的来源标记重新排列键，保留数组顺序及原有内容变更门禁；完整成品刷新后仍可导出，也不会重新调用模型。浏览器专项包含这一实际数据库恢复场景。
