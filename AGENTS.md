# Account Space 维护约束

- 后端入口为 `src/index.ts`，Hono + TypeScript；`public/` 是原生 ES modules，无前端构建和外部资源请求。业务约定见 `docs/architecture.md`。
- `npm ci`、`npm run check`、`npm run db:local`、`npm run test:e2e` 是本地验证命令。浏览器测试使用独立临时 D1 和合成凭据，仅监听 loopback；不会连接线上资源。
- 运行测试、dry-run 或本地开发时，只使用本地 D1；线上迁移与发布命令见 `docs/deployment.md`。
- 已发布的 migration 不修改；新增编号迁移，并说明与旧 Worker 版本的兼容性。恢复和导入必须先校验，再原子提交，不删除 sessions 或迁移表。
- 所有私有 API 和首页都在 Worker 鉴权。安全响应头应在路由执行后施加，防止 Assets 响应覆盖 no-store/CSP；新增入口要验证未登录路径。
- 管理员凭据仅来自 Secrets，无默认值。D1 不存密码或可离线猜测的凭据验证值；会话查找使用绑定当前凭据的 HMAC。修改认证时保留密码轮换撤销会话的测试。
- 帐号只放在 D1 和浏览器内存；浏览器 storage 仅存主题。`public/` 不存数据、配置、备份或 Secrets。
- 登录帐号可为空，但与邮箱、手机号至少填一项。邮箱分组是两个合法邮箱字段的并集；标签是帐号 JSON 数组，不建立未使用标签记录。
- 合并 UI 与 API 改动后运行真实浏览器流程，检查手机、桌面和深色主题；截图数据必须为合成数据。
- 不提交 `.dev.vars`、`.env`、`.wrangler`、数据库或真实备份。GitHub 仓库公开和 LICENSE 由所有者决定；线上验收未经执行不能标为通过。
