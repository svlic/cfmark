# 部署与运维

模板已通过本地 Wrangler schema / dry-run、D1 迁移和自动化测试。**尚未实际连接 Cloudflare/GitHub 执行部署**，不能保证官方按钮 UI、限流绑定在目标帐号的可用性或实际 Free CPU 消耗；上线前由所有者完成本文云端验收。不得将不完整部署降级为无认证或无限流模式。

## 官方按钮首次部署

1. 所有者将实现推送到 `https://github.com/svlic/cfmark`。公开模板需要公开仓库；不要为部署擅自更改公开性。许可证由所有者决定。使用其他仓库地址时更新 README 按钮。
2. 点击 Deploy to Cloudflare，使用有创建 Workers/D1 和授权 GitHub 权限的帐号。授权 Cloudflare 克隆源仓库至自己的 GitHub，并为副本选择默认生产分支。
3. 选择 Free，不开启收费套餐或附加服务。指定独一无二的 Worker 名和 D1 名，例如不同实例分别使用 `my-space-a-db` 与 `my-space-b-db`；不要复用另一个实例的 D1。
4. 平台读取 `wrangler.jsonc` 和 `.dev.vars.example`。填写 `ADMIN_USERNAME`、`ADMIN_PASSWORD`（Secret）；说明来自 package.json 的 `cloudflare.bindings`。用户名不含首尾空格；密码建议密码管理器生成至少 24 字符高熵随机值（最低 20 字符，最多 1024 UTF-8 字节），长度校验不能证明熵。
5. 自动创建并绑定 `DB` 后执行 `npm run deploy`：严格类型检查 → 本地集成测试 → dry-run 打包 → `wrangler d1 migrations apply DB --remote` → `wrangler deploy`。命令通过 `&&` 串联，检查或迁移失败不会发布。Wrangler 在非交互 CI 环境接受迁移默认确认；本地 CLI 执行仍可能提示确认。
6. 浏览器打开 workers.dev，使用刚配置的用户名/密码登录；新实例只包含默认分类，不包含任何示例帐号或抢占初始化页面。

当前 Wrangler 支持无 `database_id` 的自动资源创建，所以模板没有真实或假的个人 UUID。Deploy 按钮流程会先配置资源，再执行自定义脚本，符合官方 D1 migration 示例；普通 CLI **不能**假设迁移前资源自动存在。若平台未生成数据库绑定，先停止，不要跳过迁移。原始配置和锁定 schema 在 dry-run 中已接受，但远程自动资源创建仍属待验收项。

### 限流绑定

`LOGIN_LIMITER` 为 Workers Rate Limiting binding，5 次/60 秒，`namespace_id=1001`。此整数在同一个 Cloudflare 帐号内应唯一：如果已有绑定使用 1001，为本应用选另一个未用整数，避免不同 Worker 共用计数。第二实例也使用不同 namespace ID。不是 KV/DO，也没有额外计费组件。官方文档没有将本实现的具体 Free 帐号和 Deploy 流程替代为已测结论：必须在目标 Free 帐号核验该绑定成功创建且连续登录触发 429。若目标流程不支持此绑定，当前交付将拒绝登录，**不要移除限流绕过安全要求**；应先在隔离环境调整模板并测试后再上线。

限流按可信 Cloudflare 来源 IP，在各节点近似计数；不是全局严格保护。误触发时等待一分钟，不要重试风暴；不信任自带 X-Forwarded-For。

## 私有仓库与 CLI 备选

私有仓库可在 Dashboard → Workers & Pages → Create → 连接 GitHub 仓库（界面名称以当前控制台为准），不使用公开 Deploy 按钮。先创建独立 D1，在 `wrangler.jsonc` 的 `DB` 项填入该库 ID，并配置同名 Secret，配置生产 Builds 的构建/部署命令。绑定 ID 不是密码，但不要复用其他实例的 ID。完成后执行同样云端验收。

本地 CLI 方式适用于已安装 Node.js 的 Windows PowerShell、macOS/Linux 终端。在项目目录：

```sh
npm ci
npx wrangler login
npx wrangler d1 create your-unique-account-space-db
```

把命令返回的 `database_id`、独立 `database_name` 写入本实例 `wrangler.jsonc`，保留绑定名 `DB`；确认目标帐号、库和 Worker 都正确。随后安全交互输入，不要把 Secret 值写进命令参数或提交文件：

```sh
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

Secret 命令若提示创建 Worker，确认本次目标 Worker；或先在 Dashboard 建立空 Worker 并填写 Secret 后使用 CLI。`npm run deploy` 会写线上数据库并发布，只有所有者明确选择执行时才运行；普通 `npm ci` / `npm test` / `npm run dev` 不写远程 D1。

## Workers Builds 和预览隔离

- Cloudflare Workers Builds：安装 `npm ci`，构建可留空（deploy 已包含检查），部署 `npm run deploy`。生产分支设置为所有者选定主分支。
- `preview_urls:false` 关闭 Worker version preview URL；**这不等于自动关闭非生产分支 Builds**。在控制台关闭非生产分支部署/预览构建，核查项目实际设置。
- GitHub PR 只运行 `.github/workflows/ci.yml`，无 Cloudflare token，不会生产部署。若需要云端测试分支，必须建立独立测试 D1 与独立 Secrets/Worker，不能绑定生产数据。
- 不再建立第二套 GitHub Actions 发布流水线，不把生产凭据放在 Actions 日志。
- 后续部署只应用未执行 migrations，不重建数据库。第二实例名字和库应独立，特别检查 Deploy 页面是否选择了已存在资源。

## 自定义域名

在同一 Cloudflare 帐号中已经接入 DNS 的域名下选择未占用子域名：Worker → Settings → Domains & Routes → Add → Custom Domain。等待证书/路由生效，访问 HTTPS，验证登录 Cookie 和写入。同域名不能与其他 Worker/服务冲突；自定义域名不是一键按钮承诺范围。

确认自有域名可用后，可以关闭 workers.dev。为避免代码下次发布重新开启，同时将本实例 `wrangler.jsonc` 的 `workers_dev` 改为 false，并将实际自定义域名路由记录到该实例配置（例如 `routes: [{pattern:"accounts.your-domain.tld",custom_domain:true}]`，替换为你真实域名；不要原样复制占位域名）。核查 Dashboard 和配置一致，测试默认域名确实不可访问。

## 升级、密码重置与灾难恢复

1. 设置中先下载 JSON 备份，另按需导出 D1 SQL（含会话，安全保存），见 [备份文档](backup.md)。
2. 克隆副本不会自动跟随原仓库。用 GitHub compare / Sync fork（如果适用），或添加 upstream 后获取指定 release，阅读 CHANGELOG、审查配置差异。保留本实例 D1 ID、域名与 Worker 名，绝不要用模板覆盖这些值或复制别人的数据库 ID。
3. 在隔离本地数据上 `npm ci`、`npm run check`、`npm run db:local`、`npm run test:e2e`。迁移只新增编号，不修改已发布脚本；先评估旧 Worker 是否兼容新结构。
4. 由生产分支更新触发 Builds，或所有者执行部署命令。确认原数据仍在，功能正常。
5. Worker 版本回滚不会回滚 D1 schema；优先前向修复。不得为回滚删除已有数据或盲目重建数据库。需要恢复时先在隔离实例验证备份，再明确授权全量恢复。

密码重置：Dashboard → Worker → Settings → Variables and Secrets，修改任一管理员 Secret 并发布该配置。使用旧 Cookie 访问 `/api/auth/session` 应为 401，新凭据可登录。HMAC 查找值绑定当前用户名和密码，无需保存凭据校验列，不要改回已泄露密码。若恢复整个 D1 SQL，必须再次换成新的随机密码或明确删除 sessions；旧 SQL 可能恢复了会话。无公开找回接口。

## 免费额度与故障处理

按当前官方文档，Workers Free 通常为 100,000 请求/日、10ms CPU/调用；D1 Free 每库 500MB、每帐号 10 库，5,000,000 行读/日、100,000 行写/日，50 次查询调用/Worker 调用，单 SQL 最多 100 绑定参数。导入每表通过一个 JSON 参数 `json_each` 批量插入，6 条或3条语句一次事务 batch；不是逐条发出网络查询。D1 官方当前说明 batch 作为一次查询调用，但仍受各语句/行大小/CPU 等限制。前端本地计算视图减少 API 请求，默认会在可见时每分钟确认会话。

导入限 1 MiB/500 帐号；100 条正常数据必须先在真实 Free 实例验收。本地延迟不代表云端 CPU 用量。超额不会由本应用自动升级套餐；D1 超额、不可用或限流时返回中文 503/429，不清空数据或自动重试写入。Cloudflare 在 Worker 执行前终止的 CPU/平台错误可能显示平台错误页，应用不能保证把这种终止转换成 JSON。

常见故障：

| 症状 | 检查与处理 |
|---|---|
| 部署提示 DB 不存在/缺迁移 | 核查 Deploy 是否创建资源、`DB` 绑定和 ID；CLI 先建库再迁移；不要跳过失败继续发布 |
| “部署配置尚未完成” | 检查两项 Secrets、长度、限流绑定；不要设置默认密码或开放初始化 |
| 登录错误/429 | 用户名无首尾空格；密码空格有意义；等待一分钟，再确认设置，不要清库 |
| 突然 503 | 检查 Cloudflare 状态、D1 配额及绑定。不要把含帐号内容的 SQL 错误粘到公开 Issue |
| CPU 超限 | 核查 Free 的真实 Metrics、导入规模；先减小 CSV 单批，保留 JSON 完整备份；不自动升级付费 |
| 域名冲突/证书未生效 | 换未占用子域名，检查 DNS 接入帐号、Worker 绑定及证书状态 |
| 预览可见生产数据 | 立即关闭非生产 Builds；独立测试库/Secret 后才能重新启用 |
| JSON 版本不兼容 | 不修改 schemaVersion 绕过校验；保留原文件，使用支持该版本的应用或明确迁移工具 |
| 依赖更新失败 | 查看锁文件和兼容性，执行完整本地测试；不要盲目 `npm audit fix --force` |

## 云端验收

本次均为**未验证**，所有者在干净 Free 帐号或独立测试 Worker 中执行，并记录实际结果：

- D02：从公开仓库按钮启动，填写 Secret；确认自动创建 D1/绑定、迁移、发布，无手工 SQL；打开 workers.dev 登录并保存一条虚构帐号。若限流绑定未自动生效，停止上线并记录失败，不用无保护降级。
- D03：保存数据后重新部署并更新生产分支，核对帐号不丢；以不同 Worker/DB/限流 namespace 建第二实例，第一实例记录不得出现于第二实例，两者各自修改互不影响。
- D04：绑定自有域名，HTTPS 登录；检查 Cookie 名/属性和跨源写入 403；禁用 workers.dev 后确认仅预期域名可访问；核查非生产 Builds 禁用且无法接触生产 D1/Secret。
- D05：保持 Free，导入/导出并 JSON 恢复 100 条典型虚构资料，核对数量、中文多行/标签/手机号/空平台；检查 Metrics 无 CPU 超限、无查询超限、无付费要求；连续错误登录应触发 429。真实节点近似计数允许短时间超过阈值，不用一次观测宣称全球严格限制。

以上完成前，不把“模板可打包”宣传为“云端一键部署已验证”。

## 核对的官方来源

- [Deploy buttons（资源初始化与自定义迁移命令）](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [无 ID 自动创建资源](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 与 [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

依赖以 package-lock.json 锁定为准，Wrangler 为 4.168.0。Cloudflare 测试包按上游新名称使用 `@cloudflare/vitest-plugin`，不用已废弃的 pool-workers 包。本地核对日期 2026-11-25，线上 UI 与政策可能改变。
