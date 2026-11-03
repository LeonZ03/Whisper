# Whisper

Whisper 是一个面向熟人的小范围双人聊天实验项目。账号经管理员审批后启用，双方用完整用户名建立会话。消息在设备上加密和解密，服务端负责账号、会话权限、密文转发和限时存储。

## 开始使用

| 客户端 | 安装与更新 |
| --- | --- |
| 网页 | 打开[正式网站](https://whisper.leonz03.dpdns.org)，刷新页面即可使用新版。 |
| Windows / Linux CLI | 从 [CLI 安装页](https://whisper.leonz03.dpdns.org/cli) 复制对应平台的安装命令。已支持自更新的版本可直接运行 `whisper update`。 |
| Android | 从 [APK 下载页](https://whisper.leonz03.dpdns.org/apk) 安装。已有自更新入口时，在「我的 → 应用版本」检查更新，按系统提示覆盖安装。 |

获批后登录，搜索对方完整用户名。第一次聊天时，通过当面或其他可信渠道核对完整安全码。

## 主要功能

- **跨设备聊天**。连接同一服务的网页、Windows CLI、Linux CLI 和 Android 共用账号。在线消息通过实时通知同步，断线恢复后补拉遗漏变化。
- **限时文字消息**。发送时可选保留时间，支持双方删除；到期按原定时间清理。
- **阅后图片**。网页和 Android 发送前会压缩并加密图片。接收方看到马赛克预览，打开后只显示一次，最多三秒。CLI 会引导到网页查看。
- **登录与设备记录**。支持受保护的登录保留，可查看当前设备及最近十次成功登录。

这是未经安全审计的个人原型。服务端仍可看到通信时间、IP 等元数据，接收方也可能保留副本。加密范围、安全码与删除边界见[安全说明](SECURITY.md)。

## 常用命令

安装 CLI 后，在 PowerShell 或 Linux 终端运行：

```text
whisper
whisper --version
whisper update
whisper uninstall
```

在 Windows 上开发时，使用 Node.js 24+，在仓库目录运行：

```powershell
.\start.cmd --local-only
.\stop.cmd
```

本机实例默认访问 `http://127.0.0.1:8787`，与正式站各自保存账号和聊天数据。需要临时公网入口时，安装 cloudflared 后运行 `.\start.cmd`。

构建和回归测试：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
```

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [CLI 使用手册](CLI.md) | 安装、更新、卸载、终端操作与登录保护 |
| [Android 指南](android/README.md) | APK 安装、构建、签名与验证 |
| [安全说明](SECURITY.md) | 加密、安全码、账号恢复及威胁边界 |
| [云端部署与运维](cloud/DEPLOYMENT.md) | 正式站发布记录、管理员初始化与恢复、数据库迁移 |
| [云端认证](cloud/AUTHENTICATION.md) | 账号审批、会话和认证设计 |
| [实时同步](cloud/REALTIME.md) · [消息延迟](docs/MESSAGE-LATENCY.md) | 推送、断线补拉、免费额度与延迟测量 |
| [闪图预览](cloud/IMAGE-PREVIEWS.md) | 加密预览、图片领取及数据库兼容性 |
| [Cloudflare 新项目接续说明](docs/cloudflare-new-project-handoff.md) | 为其他项目配置独立子域名和 Cloudflare 部署 |
