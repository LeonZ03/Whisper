# Whisper 云端部署与维护

## 已验证的部署

2026-09-24：正式域名、Workers、D1 和 GitHub 推送自动部署已贯通。

| 项目 | 配置 |
| --- | --- |
| 正式入口 | https://whisper.leonz03.dpdns.org |
| Worker | `whisper`，Cloudflare Workers + Static Assets |
| 数据库 | 独立的 `whisper-production`，绑定名 `DB` |
| GitHub | `LeonZ03/Whisper`，生产分支 `main` |
| Node.js | `.node-version` 固定 `24.16.0` |
| 构建命令 | `npm test && npm run build:cloud && npm run test:cloud` |
| 部署命令 | `npm run deploy:cloud:code` |
| 项目根目录 | 仓库根目录 `/` |
| 预览分支部署 | 关闭，未配置独立预览数据库前不要开启 |

首个实测自动发布提交为 `2546866c6ad31ed1976d4e52f49d0a421e879667`，
对应 Cloudflare Build `c63aa9a0`，用时约 1 分 22 秒。
该次操作只执行 `git push origin main`，没有在本机手动部署。
正式域名 `/api/health` 随后返回相同 commit 和 `environment: cloud`。

GitHub 应用沿用已安装的 Cloudflare Workers and Pages，仅在原有 BeiPiao
之外加入 Whisper；未改为访问全部仓库，也未改动 BeiPiao 的配置和数据。

## 使用方式与数据边界

云端访问不需要运行 `start.cmd`；原启动器仍用于独立的本机开发环境。
本机账号、密钥和聊天记录没有迁移；云端应重新注册、重新核对安全码。
新的云端邀请码仅保存在所有者本机 `data/cloud-invite-code.txt` 和 Workers Secret，
不在 Git、网页源码、构建变量或公开使用说明中。不要误用本机邀请码。

CLI 安装说明：https://whisper.leonz03.dpdns.org/cli.html 。
已安装的客户端使用 `whisper --server https://whisper.leonz03.dpdns.org`。
自动发布会更新云端网页、API 和可下载客户端；不会强制更新已安装的 CLI，
CLI 升级需退出后重新执行正式安装页给出的命令。

## 日常发布

1. 在本机修改代码，运行相关测试，检查 `git diff` 和暂存文件清单。
2. 正常提交并 `git push origin main`；不要强推，不要上传 data/、密钥或生成文件。
3. 在 Cloudflare → Workers & Pages → whisper → Deployments 查看对应提交的构建结果。
4. 等待发布成功，再比对 `/api/health` 的 `commit` 与 `git rev-parse HEAD`。

```powershell
Invoke-RestMethod https://whisper.leonz03.dpdns.org/api/health
```

推送成功并不等于构建成功；构建失败时先读该次日志，不要直接重建数据库。
自动发布命令只更新代码，不运行数据库迁移或初始化 Secret。
`AUTH_PEPPER` 与 `INVITE_CODE` 仅保留在 Workers 运行时 Secrets。
既有 `AUTH_PEPPER` 必须保持稳定，不能随发布重新生成，否则会破坏已有账号验证。

## 数据库、回滚与费用

`0001_initial.sql` 已应用。后续结构变更需所有者审核后单独运行
`npm run db:migrate:cloud`，确认旧代码仍兼容，再发布代码。
严禁以重置、删除或重新创建生产库来解决部署问题。
代码回滚不等于数据库回滚。D1 Time Travel 会保留历史副本，不能承诺
已删除密文在云厂商历史备份中立即消失；直接恢复旧库可能恢复已经查看的图片。
数据库恢复必须单独设计防复现流程，不能把生产流量直接指向恢复出的旧数据。

本次未升级套餐或开启付费产品。免费额度有请求、CPU、D1 与构建时间限制；
云端轮询至少间隔 5 秒，网页后台暂停。原型仅用于小范围非敏感内容，
Native rate limits 不是全局费用上限，增加用户量前需要重新评估。

## 验证记录

- Cloudflare 自动构建实际执行了 15 项原有测试及 2 项 Workers/D1 测试。
- 上线前，本机 4 项浏览器测试及 1 项云端模拟运行时浏览器测试通过。
- 正式 HTTPS 上，3 个随机命名的临时账号验证邀请注册、登录、加密消息和第三人隔离。
- 实际 D1 上并发 4 次领取同一测试图片，仅一次取得密文，其他请求返回 410。
- 正式 Edge 页面显示加密聊天与倒计时；页面和 CLI 客户端连接同一云端实例。
- 在真实自动部署前保留测试消息与登录会话，部署后确认消息、账号 ID、公钥及会话仍有效。
- 部署后重新登录，验证仍能解密原消息；部署前打开的 Edge 页面仍能继续收消息。
- 从正式域名完整执行 PowerShell 安装命令，获得 CLI 0.4.0；测试目录独立，未改宿主用户 PATH。

临时验收只操作自身创建的账号、会话和消息，完成后精确清理这些记录；
常规 tests/ 自动测试仍使用隔离的本地数据库，不访问生产数据库。
未声称完成独立设备、独立网络的真人完整会话测试，也没有执行安全审计。

官方资料：
- https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/d1/reference/time-travel/
