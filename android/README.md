# Whisper 安卓客户端

界面采用已确认的 W 图标、森林绿、会话 / 我的底部导航。客户端连接 `https://whisper.leonz03.dpdns.org`，与正式网页、CLI 共用云端账号和未到期消息；不连接本机独立账号库。

## 安装与使用

在电脑运行 `npm.cmd run build:android` 后，安装文件在 `public/downloads/whisper-android-0.5.4-r1.apk`。将 APK 传到手机，点开并允许当前文件管理器安装该应用，可覆盖原有相同签名版本。要求 Android 8.0 或以上，且 Android System WebView / Chrome 已更新。登录、申请审批、改密、成员恢复、双人聊天、安全码和消息倒计时使用现有协议；阅后图片打开后最多显示三秒，随后先清除资源再播放空壳消散动画。

应用版本显示在登录、会话和“我的”页。APK 的界面、脚本、libsodium 与 W 图标随安装包分发，不从网页下载可执行代码。安装包升级需要使用相同应用 ID 和签名密钥；应用数据仍包含私有的公钥核对记录，禁止为修复升级而清空它。

### 防截图与后台

整个应用窗口始终启用 Android `FLAG_SECURE`，阻止标准系统截图、录屏 / 非安全投屏捕获；Android 13 及以上额外关闭最近任务截图。系统确认弹窗同样启用保护。没有关闭该保护的开关。

系统保护无法阻止另一台设备拍照、受控 / 被修改的系统或收件方使用网页 / CLI 留副本。阅后图片仅可领取一次，最多显示三秒，不承诺物理擦除或绝对防截屏。

切到后台时清除显示的消息与阅后图片，保留登录状态；切回、结束进程、手机重启后自动恢复，图片不会恢复查看。重启时直接显示会话页并在后台验证登录、同步列表，跳过登录表单和额外的健康检查请求；断网时在会话页提示重试，服务端撤销后才回到登录页。验证完成前不显示消息或开放账号操作。系统图片选择器不在应用的窗口限制内。没有后台消息通知。

登录状态通过 Android Keystore 的不可导出 AES-256 密钥、系统 AES-GCM 加密保存在 `getNoBackupFilesDir()` 下；解密只在设备进程内完成。原密码、authKey 和聊天正文不保存。无需密码或生物识别确认即可恢复，能使用已解锁手机的人也能打开会话。普通退出应用不会注销；“退出登录”删除加密登录文件及其设备密钥、撤销当前服务端会话，保留公钥核对记录。短暂断网保留登录状态，重新联网可恢复。

“我的”显示当前账号的有效登录设备、网页 / App / CLI、登录时间与最近连接 IP。旧会话在对应设备再次连接时自动补齐记录；其他旧设备显示等待连接，不用当前查看设备的 IP 代替。IP 反映最近一次认证连接，不代表最初登录时的 IP，root 的历史登录日志保持原来的记录。设备标签是客户端提供的说明，不能证明实际设备身份；列表不表示实时在线。App 登录不按普通十二小时到期，改密、恢复、账号禁用以及最多八个有效登录会话的上限仍可撤销它。卸载或清除应用数据后需重新登录。

### 数据与权限

仅申请联网权限，选图使用系统文件选择器授予的单项读取权，不申请相册 / 全盘存储权限，不持久保存图片授权。原图上限 20 MiB，本地缩放为不超过 1,000,000 字节后再加密上传；不降低密码派生次数或消息加密强度。

原密码、消息正文、原图、认证派生值不写入文件或日志。身份私钥和登录 cookie 只以安卓密钥库加密后的文件保留，不进入 WebView cookie 存储或 localStorage；只有联系人公钥核对记录使用 WebView 私有存储。关闭自动备份和设备迁移；设备被控制时这些设置不能构成保护保证。

## 开发构建

需要 Node.js 24+、JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。可以使用已安装 SDK，设置 `ANDROID_SDK_ROOT` 与 `JAVA_HOME`；默认尝试本项目 `.runtime/android-sdk`，Java 默认使用 PATH 中的程序。

首次准备 SDK 可使用官方 `sdkmanager "platforms;android-35" "build-tools;35.0.0"`。也可将 Google 官方平台包与构建工具解压到 `.runtime/android-sdk/platforms/android-35` 和 `.runtime/android-sdk/build-tools/35.0.0`。SDK、生成文件与安装包都被 Git 忽略。

```powershell
npm.cmd ci
npm.cmd run build:android
npm.cmd run test:android:package
npm.cmd run test:android
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
```

构建使用官方 aapt2、javac、D8、zipalign、apksigner，不需要 Gradle 或 Android Studio。包 ID 为 `org.leonz.whisper`，最低 API 26，目标 API 35。版本名来自根 `package.json`；版本码按 `主版本×1000000 + 次版本×10000 + 修订版本×100 + android/release.json 的 build` 生成。补发包提高 build（1–99），文件名也加入 r 序号，避免旧包混淆；不更换签名密钥。

Android 11 及以上要求 `resources.arsc` 不压缩并按四字节对齐。首包因重新压缩该文件无法安装；r2 修正打包并在签名后检查真实 ZIP 条目。`test:android:package` 同时验证发布包符合要求、原来的压缩错误会被拦截。仅通过签名或普通 zipalign 检查不足以证明可以安装。

首次构建生成独立 RSA 3072 位发布签名密钥，存入被忽略的 `data/android-signing/`。**私下备份整个目录，不要上传或放进 APK**；丢失密钥后不能覆盖升级已安装应用。环境变量 `WHISPER_ANDROID_KEYSTORE` / `WHISPER_ANDROID_KEYSTORE_PASS` 可指定已有密钥与密码，密码不进入命令参数。构建会验证 v2 / v3 签名及 ZIP 对齐，并生成公开的 `android-manifest.json`（包版本、字节数与 SHA-256，不含秘密）。

## 验证范围

`test:android` 在 Edge 中加载与 APK 相同的资源及严格 CSP，以桥接契约连接临时本机数据库，验证实际加密聊天、导航、改密、阅后图片、后台清屏和内存 cookie 清除。它不替代 Android 真机测试，不能单凭浏览器测试确认系统截图行为。

2026-09-28：r2 已在 OPPO Find X8（ColorOS 15 / Android 15，API 35）完成真机安装和启动，系统查询确认运行窗口启用 `FLAG_SECURE`。此次没有登录真实账号，也没有实际执行截图或录屏；已通过包结构检查、单元测试和网页回归测试。

2026-09-29：0.5.3-r1 完成编译、原签名验证和包结构检查，隔离浏览器加载实际 APK 资源验证后台与重启恢复、断网保留登录、显式退出清除、设备列表和三秒图片销毁。浏览器的原生桥接替身不替代设备密钥库真机验证；本轮手机未连接，未宣称新版真机安装或重启验收。云端迁移与发布状态单独见 [部署手册](../cloud/DEPLOYMENT.md)。

原生 HTTPS 入口固定为正式域名，只接受现有 API 路径；不跟随重定向、不关闭 TLS 证书或主机名校验，不放宽服务器的参与者授权。应用只加载四个打包资源，禁止外部页面、框架及脚本通过 WebView 接触原生接口。

0.5.3 的服务端设备列表需要独立应用 `cloud/migrations/0003_session_devices.sql`，不重建既有表、不重置账号和身份。云端迁移必须由所有者审核后单独执行；APK 构建不会迁移云端数据库、自动提交 Git 或发布网页。不需要 Cloudflare 付费功能、系统服务或防火墙改动。

Android 官方依据：[安卓密钥库](https://developer.android.com/privacy-and-security/keystore)、[窗口防截图标志](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE)、[最近任务截图设置](https://developer.android.com/reference/android/app/Activity#setRecentsScreenshotEnabled(boolean))、[WebView 本地内容](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)。项目整体边界见 [SECURITY.md](../SECURITY.md)。
