Whisper CLI · Windows x64 命令安装载荷

这是聊天客户端及其独立 Node.js 运行时，不是聊天服务器，也不是远程 PowerShell/SSH。
普通用户无需手动解压此文件：执行服务提供者的 PowerShell 安装命令即可。

安装之后：
  whisper                         连接安装时保存的服务器
  whisper --server https://...     使用服务提供者给出的当前 HTTPS 地址
  whisper --uninstall             卸载程序，保留公钥核对记录

进入后 /register 邀请注册，或 /login 登录；/chat 对方用户名 开始聊天。
输入文字，Enter 发送；/help 帮助；/quit 退出。不会停止提供者的服务。
临时网址改变只需改 --server，不必重新安装。更新客户端时重新执行最新安装命令。

默认安装目录：%LOCALAPPDATA%\WhisperCLI。
用户 PATH 只增加该目录下的 bin，不安装全局 Node.js，不修改机器级执行策略。
数据目录：%LOCALAPPDATA%\WhisperCLI\data；只保存公钥核对记录，不保存明文、密码或 Cookie。
不包含提供者的账号、邀请码、聊天数据库、Cloudflare 凭据或服务端代码。

网页与 CLI 共用账号和会话。图片仍需网页查看；CLI 不领取阅后图片。
未经安全审计、无前向保密，不能防截屏、终端录制或恶意发布者。
只运行来自可信提供者的代码。安装脚本在独立 PowerShell 进程中执行，不改变持久执行策略。
SHA-256 是完整性核对，不是客户端整体数字签名或安全审计。
第三方许可证在 runtime/LICENSE 和 node_modules 中。
