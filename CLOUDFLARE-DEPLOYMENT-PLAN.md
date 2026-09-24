# Whisper：Cloudflare 自动部署方案

日期：2026-09-23。状态：**待实现，仅完成分析**。本轮只新增本文档，不修改源码、依赖、运行配置、数据库、Git 或云端资源。

## 1. 结论与现状

可以实现“自有域名 + GitHub 推送后自动部署 + 电脑关机仍可访问”，但不能直接照搬 BeiPiao 的纯静态 Pages 配置；Whisper 必须同时迁移后端和持久化数据。

已读取 `../BeiPiao/README.md` 的 Cloudflare Pages 部署章节、`AGENTS.md` 第 9 节、`package.json`、`tools/build-pages.mjs`。其中记录：`LeonZ03/BeiPiao` 的 `main` 分支连接 Pages 项目 `beipiao`，执行 `npm run build:pages`，发布 `.pages-dist/`，域名为 `room.leonz03.dpdns.org`。构建脚本确认只发布静态网页和模型资源；本轮没有登录 Cloudflare 控制台复核线上配置。

已读取 Whisper 的 `README.md`、`AGENTS.md`、`package.json`、`.gitignore`、`server/app.mjs`、`src/crypto.mjs`、`scripts/launch.mjs`。当前是 Express + 本机 SQLite + 内存登录会话/限流 + 定时清理 + Quick Tunnel；浏览器负责加解密。只发布 `public/` 会缺失注册、登录、收发消息等 API。工程根目录目前没有独立 `.git` 标记；未核查 GitHub 是否已有同名仓库。

## 2. 推荐路线

采用 **Cloudflare Workers + Static Assets + D1 + Workers Builds**：前端和 `/api/*` 同域发布，D1 保存账号、公钥、加密私钥库、密文及必要元数据；GitHub 只管理代码。Workers 支持静态资源与后端一起部署，也支持仓库推送触发构建。[1][2]

拟使用 `whisper.leonz03.dpdns.org`，仅为建议，尚未检查该子域名占用或进行绑定。新建独立应用和数据库，不修改 BeiPiao 的项目、域名或仓库。[3]

```text
GitHub main → 测试、构建、部署 → Cloudflare Workers
用户浏览器 → whisper 子域名 → 网页资源 / API → D1
聊天明文与解锁私钥：仍仅在用户浏览器处理
```

Pages + Functions + D1 也可作为替代；Functions 同样受 Workers 运行时约束，并不等于原样运行本机 Node 服务。[4]

## 3. 最小改造范围

| 当前实现 | 云端适配要求 |
| --- | --- |
| 本机 Express 服务及启动器 | 增加 Workers 请求入口，复用页面与浏览器加密模块；云端不执行 `.cmd`、监听本机端口或启动 cloudflared。 |
| `node:sqlite`、本机文件 | 改为 D1 异步访问及版本化数据库迁移；Workers 的 `node:sqlite` 目前只是不可用的兼容占位，不能直接照搬。[5] |
| 登录会话与限流保存在 Map | 登录令牌只保存哈希，过期与撤销状态使用持久化存储；限流改为适合多实例的实现，不依赖某个进程的内存。 |
| 单进程图片领取与清理 | 用事务或等价原子操作绑定权限、到期检查、一次领取及清理；验证并发请求最多一次取得密文，不能直接复制异步 SELECT→UPDATE。 |
| 每 15 秒 setInterval 清理 | 所有读取/领取立即检查到期；Cron 定期清理到期数据，例如每分钟执行。到期不可读不等待清理任务。[8] |
| 图片密文直接放 SQLite | 第一版可继续将小图片密文放 D1，但限制加密、Base64 后的完整行大小，低于 2,000,000 字节并留余量；不能沿用当前 API 最大值。较大附件以后再评估 R2。[7] |
| 本机及 trycloudflare 来源白名单 | 显式配置正式域名；保留 Origin/CSRF、双人权限、Secure/HttpOnly Cookie。API 不缓存；网页资源另设 CSP 等安全头，不假定静态资源会经过后端中间件。[2] |

**登录认证是迁移前必须解决的兼容性问题。** 当前服务端 scrypt 参数 `N=131072,r=8,p=1` 的主要工作内存约 128 MiB，另有运行时开销；Workers 每个 isolate 的内存上限为 128 MB，付费计划也相同，免费 HTTP 请求 CPU 预算为 10 ms。[6][10] 需先评审、实测云端凭据验证方案，保留浏览器端密码派生与加密私钥库的保护；不得为了部署成功直接降低强度或换成简单哈希。旧账号兼容/迁移要单独设计，未通过前不发布云端版。

第一版保留轮询，不引入群聊、多设备同步或 WebSocket；增加后台暂停、退避及增量查询，避免当前高频重复拉取在云端浪费请求和数据库额度。

## 4. 后续实施顺序

1. 确认独立 GitHub 仓库、正式子域名、Cloudflare 授权和费用上限。只提交代码；保留 `data/` 忽略，并补充云端密钥文件、`.dev.vars`、`.env`、`.wrangler/` 等忽略规则。邀请码及部署凭据放 Secrets，不写入前端或 Git。
2. 先验证认证资源预算，再增加 Worker 入口、D1 表与迁移、会话/限流、原子阅后领取、Cron、安全头。保留现有 `start.cmd` 与本机模式，不改 BeiPiao。
3. 使用 Workers Builds 连接生产分支，设置“安装依赖→测试→构建→部署”；增加 Workers/D1 测试，并让浏览器测试支持 CI 环境。预览环境使用独立测试数据库和密钥，不接生产数据。[1]
4. 绑定正式域名，验证注册、登录、双人隔离、加密文字/图片、并发一次领取、双方删除、到期清理；从独立设备/网络验证，并确认关闭本机服务后仍可访问。再次推送一个测试提交，核对部署版本更新且账号/记录未被重置。

发布代码与数据库数据分开管理；正常推送不能重建或清空生产库。数据库迁移需可兼容部署顺序，代码回滚不等于数据库回滚。默认新建空的云端数据库；迁移真实账号及密文必须另行确认，保留用户 ID、公钥、加密私钥库及盐等身份关联，不能重新生成密钥冒充原账号。

## 5. 必须接受的边界

**云端删除不等于云厂商历史副本立即消失。** D1 Time Travel 始终开启，免费计划支持回溯 7 天，付费计划 30 天。[7][9] 因而图片领取后清除活动表、删除聊天记录，不能承诺历史密文在云端即时彻底销毁。恢复旧数据库还可能带回未到期但已删除/领取的内容；恢复流程必须防止这些内容重新对用户可见。采用 D1 保存消息前须确认接受此边界；若要求服务商不保留历史密文，此推荐路线需要重新评估，不能宣传为已满足。

迁移不会自动提高本原型的加密等级，仍无安全审计与前向保密，不能防截图或恶意网页发布。自动部署应保护 GitHub/Cloudflare 账号、限制生产发布权限，禁止在日志中记录正文、原密码、解锁私钥、认证凭据及 Cookie。

不承诺永久免费。Workers 请求/CPU、D1 读写及存储均需预算；尤其要验证登录计算和轮询流量。不能认为“只有几个人”就必然符合免费额度，也不能认为付费会解除全部运行时限制。[6][7]

**本地与云端将是独立环境。** 原有本机地址和临时隧道仍访问同一本机实例；新增正式域名访问云端实例，两者的账号与聊天记录默认不自动同步。更换网页来源后，本地保存的安全码核对状态也需要重新确认。

## 6. 少改代码的备选

也可使用具名 Cloudflare Tunnel，将固定子域名转发到当前本机服务。[11] 这保留本机/公网同一实例，但电脑仍须开机联网；绑定域名本身不会把 GitHub 推送自动部署到本机，还要另做受控更新机制。当前 `setPublicOrigin()` 只接受 `trycloudflare.com`，因此固定域名也不是只改 DNS 即可。

若目标是与 BeiPiao 一样无需本机常开，优先实施上述云端路线；若优先保留本机数据和较少改造，则选择具名隧道。本轮未选择套餐、创建仓库/Worker/数据库、绑定域名、推送或部署，等待用户后续确认。

## 官方依据

核查日期：2026-09-23；后续实施时重新核对平台限制。

[1] Workers Builds（Git 推送自动构建部署）：https://developers.cloudflare.com/workers/ci-cd/builds/
[2] Workers Static Assets（前后端同项目部署）：https://developers.cloudflare.com/workers/static-assets/
[3] Workers 自定义域名：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
[4] Pages Functions：https://developers.cloudflare.com/pages/functions/
[5] Workers Node.js 兼容范围：https://developers.cloudflare.com/workers/runtime-apis/nodejs/
[6] Workers CPU、内存和请求限制：https://developers.cloudflare.com/workers/platform/limits/
[7] D1 行大小、存储和历史恢复限制：https://developers.cloudflare.com/d1/platform/limits/
[8] Cron Triggers：https://developers.cloudflare.com/workers/configuration/cron-triggers/
[9] D1 Time Travel 与备份：https://developers.cloudflare.com/d1/reference/time-travel/
[10] Node.js scrypt 参数与内存说明：https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback
[11] Cloudflare Tunnel 发布本机服务：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/
