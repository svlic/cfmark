# 安全说明

这是单人帐号信息台账，不是密码管理器、端到端加密保险箱或零知识服务。请勿录入第三方密码、API Key、Token。Cloudflare 帐号管理者可访问 D1，备份文件也未加密。

- 管理员凭据只通过 Cloudflare Workers Secrets 设置；不得放在 GitHub、vars、前端或聊天中。请启用 GitHub 与 Cloudflare 二次验证。
- 若怀疑密码泄露，在 Cloudflare Dashboard 更新为新的高熵随机密码。旧会话自动失效，勿恢复使用旧密码。
- JSON/CSV/SQL 备份包含私人数据；SQL 可能还含会话查找值，安全存放并控制分享。
- 部署前阅读 [部署安全](docs/deployment.md) 和 [架构约束](docs/architecture.md)。不启用共享缓存、生产预览或请求体日志。
- 发现问题请通过 GitHub 所有者的私密渠道报告，不在公开 Issue 粘贴个人数据、Cookie、Secret 或完整备份。如仓库启用 GitHub 私密漏洞报告，优先使用该入口。

当前维护版本：1.0.x。升级依赖后执行本地测试和隔离云端验收，不通过强制 audit fix 掩盖不兼容。上线前仍需所有者核验 Cloudflare 权限、实际 Cookie、限流和免费额度。
