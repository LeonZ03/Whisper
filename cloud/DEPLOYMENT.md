# Whisper 云端部署与维护

## 当前状态

正式入口为 `https://whisper.leonz03.dpdns.org`，Worker 为 `whisper`，数据库为独立的 `whisper-production`。账号审批升级于 2026-09-24 上线为 `0.5.0`。只从本机网络核验正式 HTTPS，未做独立网络测试或安全审计。

| 阶段 | 状态 |
| --- | --- |
| 正式域名与 Worker | HTTPS `/api/health` 返回 200、`0.5.0`；Worker `whisper` |
| 兼容过渡代码 | `a9963b7` 推送 main；自动构建检查失败，使用 `deploy:cloud:code` 手动发布，正式健康检查确认该提交 |
| 独立 D1 迁移 | 兼容版本在线时应用 `0002_accounts.sql`；Wrangler 报告成功，之后无待应用迁移 |
| 完整审批认证代码 | `f2e0557` 推送 main；Cloudflare Builds `b1c692ba` 检查成功，正式 `/api/health` 返回相同完整提交号 |
| root 与线上验收 | root 已由所有者工具初始化并恢复至等待首次改密状态；唯一合成成员完成申请、审批、改密、恢复、移除，随后精确清理 |

迁移前后既有数据均为 2 个成员、1 个对话、2 条消息；验收清理后仍是这组数据。没有导入本机 `data/`，没有读取真实聊天正文或凭据。正式 root 与两名既有成员共 3 个账号。旧成员原有的较长密码长度无法从服务器派生凭据推断；客户端继续接受完整旧密码登录。

## 发布顺序

本次账号升级必须按下列阶段推进，保证旧代码与迁移之间的兼容窗口：

1. 先发布过渡兼容代码，显式提供会话 `credential_version` 等兼容列，并关闭旧的直接注册路径。确认线上过渡版本可用。
2. 所有者单独审核版本化迁移，再运行 `npm.cmd run db:migrate:cloud`。迁移只做向前兼容的结构变更；不得重置、删除或重建生产数据库。
3. 推送完整账号审批代码。等待 Cloudflare Build 成功，用正式 `/api/health` 核对返回 commit 与主分支提交一致，再验收申请、审批、登录、改密、成员恢复和双人权限。
4. 将每阶段的实际提交、迁移编号、构建结果和验收结果写回本文；上表为本次记录。

代码回滚不能恢复旧的直接注册入口；旧路径保持禁用。回滚前须确认旧版代码可兼容已迁移结构，不能靠数据库回滚或复位恢复旧行为。代码发布与数据库迁移分别记录。

## 所有者 root

本机和云端账号/数据库互相独立，分别建立 root。工具要求交互确认，不接受密码参数，也不读写成员明文或聊天内容：

```powershell
node scripts/manage-root.mjs --local
node scripts/manage-root.mjs --cloud
```

首次 root 密码固定为 `0000`。工具先在仓库 `data/` 写出随机文件名的一次性激活码，再创建 root；网页首次登录输入激活码后必须立即改密。`data/` 私有且被忽略，激活码文件不得提交、转发或打包。root 恢复需明确指定目标并带 `--recover`：

```powershell
node scripts/manage-root.mjs --local --recover
node scripts/manage-root.mjs --cloud --recover
```

恢复会替换 root 身份、撤销旧 root 会话并产生新激活码文件。恢复 root 不会重建数据库，也不改变成员身份。

## 日常发布与独立数据

普通代码推送运行 `npm run deploy:cloud:code`，不附带 D1 迁移权限。数据库迁移经审核后由维护者单独执行 `npm.cmd run db:migrate:cloud`。不要使用会把迁移和 Worker 发布捆绑在一起的通用 `deploy:cloud` 流程，除非另有明确审查和授权。

GitHub 仓库 `LeonZ03/Whisper` 的生产分支是 `main`，构建使用 `.node-version` 中固定的 Node 版本。每次发布核对 Cloudflare → Workers & Pages → whisper → Deployments 的构建状态，以及正式 HTTPS `/api/health` 的 commit。推送成功不等于构建成功，构建成功也不等于线上验收。

云端不依赖本机 `start.cmd`，也不导入 `data/`。云端与本机各有独立账号、密钥、消息和 root；重新申请后须重新核对安全码。Workers Secrets 中的 `AUTH_PEPPER` 等运行时秘密不得进入源码、构建资源或客户端包；保持既有 pepper 稳定。

## 数据、日志与回滚边界

账号拒绝/移除是软删除：禁用账号、撤销会话并封存对话，身份墓碑保留；活动消息依原到期时间清理。D1 历史功能可能保留已删除密文；恢复旧备份可能重新出现旧数据或已领取图片。不得直接对外开放恢复出的旧库。

root 登录日志会保存到达应用的 root 登录尝试时间、来源 IP 和估计位置。当前不自动清除这些日志；所有者需自行决定后续保留和清理策略。申请说明、账号状态、审批及恢复审计由服务端处理。不要承诺匿名或不留 IP。

不升级付费套餐，不为这次工作更改其他域名。Cloudflare 额度和边缘限流都不是全局费用保证。线上验收只使用唯一合成账号，并精确清理自己创建的数据；常规自动化应使用隔离临时数据库。
