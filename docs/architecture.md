# 架构与业务约定

## 运行边界

单 Worker 处理 Hono API、认证、安全响应头和 Static Assets，绑定一个 D1 和一个 Workers Rate Limiting binding。不需要 Pages、KV、R2、Durable Objects、Redis、外部 API 或付费 SaaS。前端是 HTML/CSS/原生 ES modules，TypeScript 仅用于后端和自动化测试。没有 Service Worker、遥测、favicon 抓取和外部字体。

`assets.run_worker_first=true`；`html_handling=none`，Worker 显式将 `/` 映射为 `index.html`、`/login` 映射为 `login.html`，避免 Static Assets 的 HTML canonical redirect 形成循环。静态资源和登录页可公开读取，但不含任何业务数据。首页及直接 `index.html` 路径要求登录，未知 API 独立返回 JSON 404；未知 API 也先鉴权。

## 数据模型

- `platforms`：平台名称、默认网址。SQL NOCASE 约束阻止 ASCII 大小写重复，应用层 `trim().toLowerCase()` 统一校验包含 Unicode 的名称。改名不改变 ID。删除被引用平台禁止，外键 RESTRICT 兜底。
- `categories`：名称、整数排序。删除先把关联帐号置为未分类并更新修改时间，再删除分类，原子 batch 提交。
- `accounts`：八个业务字段及系统 ID/UTC 时间。空字段统一 NULL；登录帐号/绑定邮箱/手机号至少一项有效非空。邮箱要求普通有效格式，不做 DNS 查询。手机号始终是字符串；用户的普通用户名保留大小写。备注纯文本；选填文本按需求去首尾空白。
- `tags`：帐号表中 JSON 字符串数组，最多 20 项、每项 50 字符，精确字符串去重。全局重命名/合并/删除一次 SQL 更新所有引用并刷新修改时间。没有独立未使用标签。
- `sessions`：只保存 HMAC 查找值和 Unix 秒时间；外加 D1 自身 migrations 表。JSON 恢复只修改前三类业务表，不触碰认证和迁移记录。

帐号级 `login_url=NULL` 表示继承平台，查询时 `COALESCE` 计算有效网址。CSV 导出只有八列，网址输出当时有效值；CSV 导回会变成专属覆盖，只有 JSON 能保留“继承”语义。

## 分组、筛选与重复

- 首屏一次获取完整帐号和基础数据；平台/邮箱组按中文 locale 名称稳定排序，帐号按最近修改时间、ID 倒序。
- 顶部统计使用全部帐号：不同平台数指被帐号引用的平台，空平台在设置维护，不计入该统计。邮箱数为合法登录邮箱与绑定邮箱的 trim + 小写去重并集；不合并 Gmail 点号、+ 后缀或别名。
- 同帐号两个字段命中同一邮箱，只计一个帐号，同时显示登录邮箱/绑定邮箱；两个邮箱不同则可在两组出现。普通用户名/仅手机号不会参加邮箱视图。
- 全局搜索包含平台、登录帐号、邮箱、手机号、备注、分类、标签、专属与默认网址。分类和标签是单选筛选。具体邮箱搜索只显示该邮箱组，不带出同帐号的另一个邮箱。统计不随筛选变化，结果数单独显示。
- 重复候选仅在同平台判断：相同非空用户名（有效邮箱用户名按小写比较，普通用户名精确比较）；双方无用户名时同邮箱；双方也无邮箱时同手机号。允许确认后保存，编辑排除自身。跨平台关联邮箱不重复。
- 多设备采用后写覆盖，无乐观锁。并发创建时若 ID/名称发生冲突，原子写入会整体失败，不自动重试以免重复。遇到网络错误，先刷新核查是否写入再重试；不要同时编辑或导入。

## 认证与安全

Secrets 为 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，最低 20 字符、最多 1024 UTF-8 字节，建议密码管理器生成至少 24 字符高熵随机值。长度不能证明熵。密码原样比较，不 trim。输入与 Secret 计算固定长度 SHA-256 后调用 Workers timingSafeEqual，仅用于比较，不持久化摘要；这不是数据库用户密码方案。

每次登录生成 32 字节随机 token，D1 保存以当前两项凭据为密钥的 HMAC-SHA-256 查找值，不提供离线密码验证材料。修改任一凭据后，旧 Cookie 无法查到会话；不要回滚至已泄露的旧凭据。默认绝对 24 小时、记住登录 30 天；默认浏览器会话 Cookie 可能在关闭浏览器时清除。成功登录有限清理过期会话，退出删除当前服务端会话。

生产 Cookie 是 `__Host-session; Secure; HttpOnly; SameSite=Strict; Path=/`，没有 Domain。只有 HTTP 的 localhost/127.0.0.1/::1 使用 `dev-session`；客户端参数不能开启不安全模式。开发服务器不要暴露公网。所有写入（包括登录、退出、导入）检查精确同源 Origin；POST/PUT 校验 JSON Content-Type 与实际字节；普通请求上限 32 KiB，导入 JSON 封装上限约 6 MiB，内嵌文件上限仍为 1 MiB。

登录每个可信 `CF-Connecting-IP` 限制 5 次/60 秒（local 用单一本地 key）；不信任 X-Forwarded-For。缺少生产 IP、配置或限流绑定拒绝。限流是按 Cloudflare 节点的近似值，不是全球严格限制。应用没有公开注册或找回密码接口。

安全响应头覆盖 HTML/API/错误：no-store、CSP（无 unsafe-inline/eval）、no-referrer、nosniff、禁止嵌入、HTTPS HSTS。API SQL 全部参数绑定，表名只来自封闭常量。所有用户文本通过 DOM textContent；网址只允许 http/https 且服务端拒绝内含凭据的地址，跳转使用 noopener/noreferrer。

应用不输出帐号详情、密码、Cookie、SQL 错误或导入内容到日志；D1 异常转为通用 503。请勿自行启用请求体/响应体日志或 Cache Everything。D1 并非端到端加密保险箱；禁止把第三方密码、API Key、Token 放入备注。
