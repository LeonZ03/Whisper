# Whisper：Cloudflare 部署进度与方案

更新：2026-09-24。用户已确认正式域名 `whisper.leonz03.dpdns.org`。
技术适配、空数据库初始化和 Worker 首次发布已完成，域名已绑定。
**运行时 Secret 已初始化，GitHub Builds 连接与最终线上验收尚未完成，不应宣布完整上线。**
具体设置和后续状态见 [cloud/DEPLOYMENT.md](cloud/DEPLOYMENT.md)。

## 架构

```text
GitHub LeonZ03/Whisper · main
  → Cloudflare Workers Builds（连接待完成）
  → 测试 → 构建 → 只发布代码 → Worker + Static Assets（数据库迁移单独审核执行）

正式域名 → 网页 / 同域 API / CLI 安装入口
          → D1 独立数据库
聊天加解密 → 用户浏览器或本机 CLI
```

网页、CLI、倒计时、阅后图片和双方删除继续使用同一应用协议。
本机 Express/SQLite 保留在 `server/app.mjs`；云端入口在 `cloud/worker.mjs`。
本机与云端是两个独立实例，没有同步账号、密钥或聊天记录。
BeiPiao 项目、仓库和 `room` 子域名不受影响。

## 已实施的适配

- D1 异步参数化 SQL、版本化迁移、持久化会话；只有令牌哈希进入数据库。
- 原子一次领取：从独立图片密文表 `DELETE ... RETURNING`，同语句触发器标记已领取；并发请求最多一个取得密文。
- 所有读接口立即检查到期，Cron 每分钟清理活动表，不等待 Cron 才停止展示。
- Native rate limits、固定两人权限、Origin/请求头校验、Secure Cookie 和静态安全响应头。
- 云端轮询间隔至少 5 秒，网页后台暂停轮询；倒计时独立刷新不增加请求。
- Linux/Windows 均可构建云端资源。安装包使用官方 SHA-256 固定的 Windows Node 运行时，不复制本机依赖环境或数据。
- 超过静态单文件限制的 CLI ZIP 拆为内容寻址分片，再通过 Worker 原路径流式返回；校验完整 ZIP 一致性。

## 认证与删除边界

客户端的 PBKDF2-HMAC-SHA256 600,000 次和 HKDF 密钥分离保持不变。
Workers 无法容纳原本服务端 scrypt 的约 128 MiB 工作区和运行时开销；
云端改用单独 Secret 中的随机 pepper，对客户端派生凭据做域分离 HMAC 验证。
这不是简单哈希，也不保存可复用的 authKey，但不等价于保留额外 scrypt 工作因子。
完整威胁分析见 [cloud/AUTHENTICATION.md](cloud/AUTHENTICATION.md)。

D1 Time Travel 会保留历史密文；删除活动数据不是对云厂商备份的立即擦除。
不得直接恢复旧库后开放访问，否则已领取图片/已删除记录可能重新出现。
本次没有开通付费服务，不承诺免费额度永远足够。达到请求或 CPU 上限应先优化或征求费用确认。

## 验收门禁

1. 运行时 Secret 配置后，两个云端账号完成实际注册、登录、文字/图片、双方删除与到期验证。
2. 正式域名 HTTPS 与 workers.dev 均返回云端实例；不能回源本机隧道。
3. 通过 GitHub main 的实际推送触发构建，核对部署提交与 `/api/health` 的 commit 一致。
4. 更新部署不重置数据库；预览环境不得复用生产数据库。
5. 继续通过原本本机、网页、终端测试；不将测试数据写入真实聊天库。

官方参考：
- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/reference/time-travel/
