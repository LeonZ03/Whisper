# Whisper

一个申请审批制的双人聊天实验项目，同时提供网页和 PowerShell 交互界面。
消息在发送者设备加密、接收者设备解密；服务端负责账号、权限、密文转发和限时存储。

**这是未经安全审计的个人原型，不承诺完全匿名、前向保密、防截图或远程彻底擦除。请先使用非敏感内容。**

## 云端部署（0.5.0）

正式域名已绑定为 `https://whisper.leonz03.dpdns.org`，云端使用 Workers + Static Assets + D1。
账号审批与认证升级已于 2026-09-24 发布到正式域名；增量迁移、自动构建和线上合成账号验收均已完成。发布记录见[部署手册](cloud/DEPLOYMENT.md)。
Cloudflare 中已创建 Worker `whisper` 和独立数据库 `whisper-production`，没有迁移本机账号或聊天记录。
云端服务不依赖本机开机；网页和 CLI 同时连接正式域名。原来的 `start.cmd` 仍启动独立本机环境。
云端和本机账号、聊天记录不自动同步；两边分别申请账号并等待各自的所有者审批，首次聊天需核对安全码。

直接访问 [正式网页](https://whisper.leonz03.dpdns.org)；[CLI 安装页](https://whisper.leonz03.dpdns.org/cli.html) 提供当前安装／更新命令。
新版本不再使用邀请码。首次建立 root 管理员及恢复 root 的方法见下文。

```powershell
whisper --server https://whisper.leonz03.dpdns.org
```

修改代码、测试并提交后，执行 `git push origin main` 即触发自动构建。
在 Cloudflare 的 whisper → Deployments 中确认成功，再核对 `/api/health` 返回的 commit。
自动发布不清空数据库、不重新生成密钥；本机 `start.cmd` 不需要为了云端网站保持运行。

部署步骤、运行时 Secret、自动构建设置及验收清单见 [部署手册](cloud/DEPLOYMENT.md)。
[云端认证说明](cloud/AUTHENTICATION.md) 说明与本机认证的差异，客户端的加密协议及 60 万次密码派生没有降低。

## 能做什么

- 提交账号申请、经所有者审批后登录，按完整用户名建立固定双人会话，没有群聊。
- 网页和 CLI 共用账号、身份密钥及未到期消息，可以互相聊天。
- 文字保留时间可选 1 分钟、1 小时、24 小时、7 天；两端均显示实时倒计时。
- 消息到期或双方删除时，网页先清除正文，再用不含内容的卡片做短暂淡出；支持系统减少动态效果设置。
- 网页支持一次查看图片：本机处理并加密上传，接收方打开后最多显示 10 秒，未打开最多保留 24 小时。CLI 不领取图片，请在网页查看。
- CLI 支持颜色、`/` 前缀菜单、上下键命令回溯、聊天历史分页和不覆盖聊天的帮助输出。

## 服务提供者：本机启动

开发及已验证运行环境为 Windows x64、Node.js 24+、npm；公网入口还需要安装 cloudflared。
浏览器测试使用 Microsoft Edge。客户端打包需要有效签名的 Windows Node.js 运行时。

```powershell
git clone git@github.com:LeonZ03/Whisper.git
cd Whisper
.\start.cmd
```

首次启动会在项目内安装依赖、构建网页并准备 CLI 发布包，然后启动本机服务和 Cloudflare 临时隧道。
如果客户端打包失败，网页服务仍会尝试启动；查看报错后运行 `npm.cmd run build:cli` 单独排查。

启动窗口会显示本机地址（默认 `http://127.0.0.1:8787`）、临时 HTTPS 网址和朋友使用的 CLI 安装/连接命令。
同样的访问信息在 `data/access-info.txt`；CLI 命令单独写到 `data/cli-commands.txt`。
**本机地址和临时网址访问同一个本机实例。** 朋友只能用公网地址，他的 `127.0.0.1` 指向他自己。

停止服务运行 `.\stop.cmd`，或在启动窗口按 Ctrl+C。仅本机、不建立公网隧道：

```powershell
.\start.cmd --local-only
```

仅对于上述本机＋临时隧道模式：电脑关机、休眠、断网后外部无法访问该本机实例。正式云端域名不受影响；每次重建临时隧道网址可能变化。
不要把“隧道已连接”当成所有访问者都已能打开网页。临时隧道没有可用性保证，也不是永久云端托管。

## 使用网页

打开网址，提交账号申请（用户名 3–24 位小写字母、数字或下划线）。申请无需邀请码；管理员批准后才能登录。新设密码为 1–12 个 Unicode NFC 规范化码点。极短密码很容易被猜中，请尽量使用较长且不重复的组合。已有账号可继续用原密码登录；修改密码时须设置符合新规则的密码。
双方各用自己的账号，在左侧输入对方完整用户名；首次聊天应通过当面或其他可信渠道核对完整安全码。
同一电脑测试两个账号，用两个浏览器或普通窗口加无痕窗口，不要用同一网址的两个普通标签页。
输入消息，Enter 发送，Shift+Enter 换行；下方选择的是新消息的保留期限，不是预约发送时间。

每条消息旁显示剩余时间；一分钟内变为黄色、十秒内变为红色。到期按绝对时间清理，不因刷新、后台恢复或动画重新计时。
单条“双方删除”与“双方清空”只约束正常客户端，不能清除截图、导出和其他人保留的副本。

## 管理员初始化与账号维护

每个本机或云端实例分别初始化自己的 `root`。本机服务先启动一次以创建数据库，随后停止服务；在仓库目录运行 `node scripts/manage-root.mjs --local`。云端运行 `node scripts/manage-root.mjs --cloud`。工具会要求交互确认，首次密码固定为 `0000`，并在 `data/` 写出随机名称的私密一次性激活码文件。首次登录网页时使用该激活码，随后立即修改密码。妥善保管并在完成后删除激活码文件。

正式云端的 root 已建立，处于等待首次激活和改密状态；不要重复运行初始化命令。忘记密码时才由所有者运行云端 `--recover` 命令。本机 root 仍需按本机环境单独建立。

成员申请通过后，root 可批准、拒绝、移除账号，或签发一次性恢复码。恢复码只显示一次，应通过私下渠道交给本人。成员忘记密码恢复会生成全新身份密钥并封存旧会话；旧消息无法解密，联系人需要重新核对安全码。root 本身只能由所有者在服务器/仓库维护环境运行 `node scripts/manage-root.mjs --local --recover` 或 `node scripts/manage-root.mjs --cloud --recover` 恢复；这会撤销 root 会话、重置 root 身份并产生新的激活文件。

账号移除是软删除：撤销登录、封存会话并保留身份墓碑；消息密文按原期限清理，不承诺数据库历史副本立即消失。root 登录记录保存到达应用的 root 尝试时间、IP 与估计位置；位置只是网络估计，不代表住址。失败计数使用账号范围摘要，应用运行中的限流会临时使用来源 IP。不要把申请说明当作端到端加密内容。

## 朋友：在 PowerShell 安装和聊天

在朋友自己的 PowerShell 执行启动窗口给出的完整安装/更新命令，或者从当前公网网址的 `/cli.html` 复制。
安装器通过同一 Cloudflare 入口下载、校验客户端及独立运行时，安装到 `%LOCALAPPDATA%\WhisperCLI` 并添加用户 PATH。
无需管理员权限，无需自行安装 Node.js/npm/Git；不需要运行服务器，更不是 SSH 登录服务提供者的电脑。
只执行来自可信提供者的命令。复制纯文本代码，不要将 Markdown 链接或多余反斜杠带进 PowerShell。

```powershell
whisper --server https://实际的当前公网网址
whisper                 # 使用安装时保存的地址
whisper --version       # 检查已安装版本
whisper --no-color      # 单色界面
whisper --uninstall     # 卸载客户端，默认保留公钥核对记录
```

网址变化只需替换 `--server`，不必重装；客户端升级时重新执行最新安装命令。退出 CLI 不会关闭聊天服务。

| CLI 内部命令 | 用途 |
| --- | --- |
| `/login`、`/register` | 登录、提交申请；root 只在网页管理 |
| `/passwd`、`/recover` | 修改密码并保留身份，或使用管理员一次性恢复码重建身份 |
| `/chats`、`/chat 用户名` | 列出会话、选择聊天对象 |
| `/safety` | 核对双方安全码 |
| `/ttl 1m` | 新消息保留期限；也支持 `1h`、`24h`、`7d` |
| `/delete 12`、`/clear` | 删除消息 #12、清空双方已有消息，需确认 |
| `/help`、`/web`、`/refresh` | 帮助、网页入口、刷新 |
| `/logout`、`/quit` | 退出账号、退出 CLI |

输入 `/` 显示菜单，↑↓ 选择、Enter 确认；没有菜单时 ↑↓ 回溯当前会话的有效命令，不记录聊天正文或密码。
鼠标滚轮、PageUp/PageDown 翻阅聊天；Ctrl+End 回底部；Ctrl+J 换行。详细说明见 [CLI.md](CLI.md)。

## 开发与重要命令

```powershell
npm.cmd ci
npm.cmd run build           # 打包网页到 public/app.js
npm.cmd test                # 密码、API、CLI 等单元与集成测试
npm.cmd run test:e2e        # Edge 网页互通、倒计时与到期动画测试
npm.cmd run test:cli:tty    # 真实 PowerShell / ConPTY 交互测试
npm.cmd run build:cli       # 构建或复用独立 CLI 发布包
npm.cmd run test:cli:package
npm.cmd run test:cli:install
```

工程内的 CLI 开发入口是 `.\whisper.cmd`，无需安装为全局命令。依赖和工具仅在工程内准备，不自动安装系统服务或修改防火墙。
可通过 `WHISPER_PORT` 更改服务端口，`WHISPER_DATA_DIR` 更改数据目录，`WHISPER_CLOUDFLARED` 指定 cloudflared 可执行文件。

| 位置 | 内容 |
| --- | --- |
| `src/`、`public/` | 浏览器源码、共享加密模块、静态界面 |
| `cli/` | 终端界面、同协议客户端、仅本机命令输出 |
| `server/` | Express、SQLite、账号与双人权限、密文接口 |
| `scripts/`、`client-distribution/` | 构建、启动/停止、命令安装脚本 |
| `tests/` | 使用临时数据的自动化回归 |
| `data/` | 真实账号、密文、root 激活码、运行状态；只留本机，禁止提交 |

`README.md` 面向使用者；[AGENTS.md](AGENTS.md) 面向维护 AI；[CLI.md](CLI.md) 记录终端细节。
[云端部署方案](CLOUDFLARE-DEPLOYMENT-PLAN.md) 与 [实际部署手册](cloud/DEPLOYMENT.md) 记录当前进度。**Git 推送成功、云端构建成功和线上验收通过是不同的状态；代码推送不会同步聊天数据库。**
生成的网页 bundle、CLI ZIP、依赖、测试报告、日志和秘密配置不入 Git；新克隆通过构建重建。

安全机制与威胁边界见 [安全说明](SECURITY.md)。

## 安全与使用边界

使用 libsodium 认证加密原语，但整体协议未经安全审计，没有 Double Ratchet、前向保密或后量子保护。
私钥以密码派生密钥加密后保存在服务器；数据库被盗可遭离线猜密。成员恢复会替换身份，不能找回旧身份密钥或旧消息。
服务器或发布代码被篡改、终端被控制、恶意扩展、录屏或截图都可能泄露内容。删除动画只是界面反馈，不代表物理擦除。
服务端与转发商仍可能看到 IP、时间、大小和通信关系等元数据。昵称不等于匿名网络。
本项目未完成公开运营所需的合规流程；小范围、免费和使用加密不自动免除适用义务。尚未为原创代码指定开源许可证。

## 云端维护命令

```powershell
npm.cmd run build:cloud    # 构建云端网页、Worker、可跨平台生成的 Windows CLI 载荷
npm.cmd run test:cloud     # 真正的 workerd/D1 隔离测试，不连接生产库
npm.cmd run deploy:cloud:code # 仅发布代码，不运行数据库迁移
npm.cmd run db:migrate:cloud  # 单独审核迁移后才运行
```

D1 历史恢复可能保留删除前的密文；界面到期和活动表删除不等于历史备份立即消失。
恢复数据库前必须暂停公开访问并处理被恢复的已删除/已领取内容，不能直接把旧备份重新上线。
未开通付费套餐；云端请求、CPU、数据库额度仍有限，不能承诺永久免费或无限使用。

普通自动部署只运行 `npm run deploy:cloud:code`，不会给每次代码推送附带数据库写入/迁移权限。
数据库结构有变更时，由所有者审核后单独运行 `npm.cmd run db:migrate:cloud`，再发布兼容代码。
云端构建的 Node.js 版本在 `.node-version` 固定为 24.16.0。
