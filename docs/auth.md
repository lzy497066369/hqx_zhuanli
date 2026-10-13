# 登录和注册

登录、注册、退出与会话恢复已经接入 MySQL。未登录时只显示账号页面，服务端同时拒绝项目、资料库和 AI 业务接口访问；仅账号接口和存储健康检查可匿名访问。注册成功后自动进入工作台，刷新页面保留登录状态。

账号为 3–32 位字母、数字或下划线，不区分大小写，数据库有唯一索引。昵称可选，默认使用账号；密码为 8–128 位。重复账号、错误密码、两次密码不一致、服务故障均显示具体提示。当前不提供找回密码和权限管理页面。

## 新增表和字段

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `users` | `id`, `username`, `display_name`, `password_hash`, **`role`**, `created_at`, `updated_at`, `last_login_at` | 用户账号、昵称、密码哈希、预留权限字段与时间 |
| `user_sessions` | `token_hash`, `user_id`, `expires_at`, `created_at` | 登录会话摘要、所属用户、过期与创建时间 |

`users.role` 为 `VARCHAR(32) NOT NULL DEFAULT 'user'`。注册接口固定写入 `user`（普通用户），忽略客户端传入的 role；没有自动创建管理员、修改权限或后台管理接口。权限字段以后可以扩展。

密码使用随机盐和 Node 的 scrypt 存储，数据库没有明文密码。登录会话使用随机 32 字节令牌，仅 SHA-256 摘要保存在数据库；浏览器使用 `HttpOnly`、`SameSite=Lax` Cookie，HTTPS 时附加 `Secure`。会话有效期 7 天，每个用户保留最多 10 个有效会话；退出立即删除当前会话并清除 Cookie。账号接口具有同源校验、请求体限制和按来源 / 账号的尝试次数限制。

`server/mysql/auth.sql` 是数据库结构来源，由现有初始化程序自动执行并记录第 2 版迁移：

```sh
npm run db:migrate
```

接口：`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`。登录与注册输入为 `username`、`password`，注册可带 `displayName`。接口只返回用户公开字段，不返回密码哈希或会话令牌。

## 部署

生产默认启用登录；Compose 明确设置 `AUTH_REQUIRED=true`。局域网 Caddy 网关转发到前端 Nginx，原来的共享 Basic Auth 登录框由应用内登录注册取代，访问地址不变。历史回归测试显式使用 `AUTH_REQUIRED=false`，仅用于隔离测试环境。

账号拥有独立工作空间，一个账号可新建多个空间，项目、草稿和资料按空间隔离。空间管理和新增字段见 [独立工作空间](workspaces.md)。尚未实现角色权限管理。数据库故障或会话过期时保存失败会提示未保存状态，先备份当前修改再重新登录。

## 验证

```sh
npm run test:auth
npm run lint
npm run build
```

真实 MySQL 测试覆盖角色参数不能提权、密码与会话摘要、重复账号、错误密码、未登录拦截、注销、过期与伪造会话、服务重启后恢复、跨站请求和登录限流。浏览器测试覆盖注册自动登录、刷新、用户信息、退出和重新登录、手机布局、无障碍检查及服务故障重试。测试账号会自动删除。
