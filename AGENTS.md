# Whisper project rules

- This is a small, invitation-only local prototype, NOT an audited secure messenger.
- Do not claim anonymity, forward secrecy, remote secure erasure or screenshot prevention.
- Never log or persist plaintext messages, original passwords, unlocked private keys, auth keys or session cookies.
- Keep data/ private and ignored. Do not delete real accounts/data for tests.
- All browser dependencies must be locally bundled. No analytics, third-party scripts, fonts or CDNs.
- Do not hand-roll encryption primitives or silently downgrade crypto.
- Fixed two-person conversations and participant authorization must be enforced on the server.
- Preserve localhost + Cloudflare Quick Tunnel serving the SAME local instance.
- Do not modify global cloudflared configuration, install services or change firewall rules.
- Run npm test and npm run test:e2e after changes; browser tests use isolated temporary databases and Edge.
- Document protocol limitations and breaking database changes in README.md.

## 四端功能同步（所有者要求，2026-09-29）

- 网页、Windows CLI、Linux CLI、Android App 分别验收；以下 CLI 规则同时适用于两种桌面系统。共享脚本不代替真实 Windows ConPTY、Linux PTY 和 Android 打包传输检查。

- App、网页版、Windows CLI 和 Linux CLI 共用一套产品行为。涉及账号、设备记录、消息生命周期、发送反馈、版本和服务信息的需求，必须同时检查四端；不能默认只改当前正在操作的一端。
- 开工时列出四端的现状、缺项和平台差异；实现与验收分别标明每端结果。版本号相同、共用后端或某端已经写入元数据，不代表其他客户端已经具备可用的查看入口与交互。
- 同一账号的设备记录统一复用现有认证 API：提供当前设备标识和最近十次成功登录，包含方式、登录状态、登录 / 结束时间、最近连接 IP 与估计地区；按登录时间保留至多十条，退出后仍可查看，和八个有效会话上限分别处理。图形界面可滚动，CLI 使用现有可翻阅的终端记录；root 原有审计不受十条上限影响。
- 账号、修改密码、设备、服务、版本和隐私信息在三端应有对应入口，按平台适配布局和命令。CLI 信息输出继续追加到当前会话，不覆盖聊天、不发送给联系人；文本先净化再配色，保留草稿、阅读位置和到期清理。
- 持久登录、显式退出及服务端撤销的目标体验需同步评估；必须使用各平台适合的受保护存储并说明实际支持范围。Android Keystore 例外不授权网页或 CLI 明文保存私钥、密码、authKey 或 cookie，不可仅为免登录降低现有保护。
- 所有者确认三端同步后，0.5.6 允许网页在同源 IndexedDB 保存不可导出的 WebCrypto AES-GCM 密钥及身份密文（cookie 仍由浏览器 HttpOnly 管理），Windows CLI 仅保存 DPAPI CurrentUser 保护的 cookie 与身份密文。不得保存密码、authKey、聊天正文或原始私钥；不得明文降级。保护不可用时提示临时登录；正常关页 / 退出程序保留密文，显式退出、改密或恢复、服务端撤销清除。浏览器配置文件与同一 Windows 用户下的恶意代码仍在保护边界之外。
- App 与网页的图片压缩、三秒查看和先清除内容再消散的规则一致。CLI 保持不领取、不保存阅后图片，用网页入口提供等效引导；消息到期及时清理，视觉提示按终端能力适配，不能为动画延迟清除正文。Android 的系统截图限制属于平台差异，网页 / CLI 不承诺防截图。
- 发布前检查四端版本、资源 / 安装包及受影响的回归测试；有意分阶段发布或保留平台差异时，在交付中明确说明，不能把某一端完成描述为四端全部完成。当前上线状态仍记录在 cloud/DEPLOYMENT.md。

## CLI maintenance

- CLI must reuse src/crypto.mjs and the existing API; no protocol downgrade or server auth bypass.
- Keep passwords, decrypted messages, private keys and cookies out of CLI arguments and history. Windows files may contain DPAPI sealed login; Linux files may contain AES-GCM login ciphertext with random keys kept only in the user's Secret Service keyring. Never plaintext credentials or messages.
- CLI public-key pins are private metadata in ignored data/; never silently reset them.
- Treat terminal messages as untrusted text: strip VT/OSC/control sequences; never execute message text.
- Apply color only after sanitizing/wrapping, using trusted UI metadata; message text must not choose UI roles. Keep NO_COLOR/--no-color usable and preserve history anchors.
- CLI must not consume view-once images or save image files; use the web interface.
- Test changes with npm test, npm run test:e2e and npm run test:cli:tty (Windows). Use temporary databases only.

## CLI distribution

- Command installation is the supported visitor path; keep CLI.md as the single usage guide.
- Never include host data or credentials in the client release. Retain the ZIP as an installation payload, not a project backup.
- Generate launcher and web install commands from public/cli-command.mjs.
- Installer tests MUST use temporary paths and NoPath; never mutate the host user PATH for tests.
- Installer feedback must show real installation stages and download progress, then an English result distinguishing first install, version upgrade and same-version reinstall. Print success only after activation; never call a downgrade an upgrade.
- Linux support reuses the same CLI, crypto and API. Bundle verified official x64 / arm64 glibc Node runtimes; do not require global Node, npm, sudo or host secrets. Keep the Windows manifest and download URL compatible. Linux tests use isolated HOME, install / bin directories and no profile changes; exercise a real Linux PTY, installation, upgrade and uninstall before claiming support.
- Linux persistent login requires usable Secret Service via secret-tool. Missing protection means an explicit temporary login, never a plaintext fallback. Keep ciphertext when a keyring is temporarily locked; logout must unlink the local vault even if keyring cleanup fails. Key material goes through pipes, never command arguments. Keyring integration tests must use a separate D-Bus session and temporary keyring, never the user's real keyring.
- Run test:cli:install and test:cli:package for installer/release changes.

## CLI interaction guarantees

- Up/Down recall only validated slash commands in memory (maximum 100); preserve the unsubmitted draft. Menu navigation takes priority. Never record chat text, passwords, invitation codes, prompt answers or invalid credential-bearing arguments.
- Clear command recall on account/server changes and exit. Do not add an on-disk history file.
- Informational command output belongs in the current conversation transcript, not a replacement chat screen. Never keep copied message bodies in command-output blocks.
- Countdowns use the existing absolute message expiry and repaint without extra network requests. Keep deletion/expiry filtering active, including for messages preceding a help block.
- Run cli-interaction unit tests plus the installed PowerShell/ConPTY regression for changes to these behaviors.

## Web lifecycle and repository maintenance

- Real-time v1 uses authenticated one-use tickets, WebSocket invalidations, and `/api/sync` cursors. Follow `cloud/REALTIME.md`. Never put tickets or session credentials in URLs, logs or command arguments; Android obtains tickets through its native authenticated HTTPS bridge and keeps cookies there.
- D1 is authoritative. The bounded journal records mutations in the same transaction, including removal, image consumption, archive and identity changes. Commit before best-effort notification; a notification failure must not turn a committed send into an error. Expiry remains absolute.
- Use hibernating SQLite Durable Objects on the existing plan, no server-side D1 scanning loop. Stop high-frequency polling with realtime capability; keep bounded jittered reconnect and low-frequency incremental repair. Logout, revocation, account changes and selected-conversation changes must invalidate old async results.
- Never broaden message/account limits or weaken image claiming to gain throughput. Validate authenticated, anonymous, send and connection rate limits separately. Do not mistake one-IP limits or measured request reductions for a concurrency capacity guarantee.
- Run `npm run test:realtime` plus existing regressions. Linux installer/PTY tests use isolated HOME, directories and keyring. Android browser/bridge tests must be labelled as simulations; actual APK/native transport and connected-device checks are separate results.

- `src/message-lifecycle.mjs` owns the browser countdown and disappearance effect. Countdown uses the existing absolute expiry, never a new lifetime starting at render time.
- Reuse message DOM nodes across polls. Timer ticks update only changed labels and must preserve input focus, drafts, and reading position.
- Clear the message content before animating the empty shell. Respect reduced motion; cancel timers and effects on conversation changes, logout, and disconnection.
- Keep the three-second view-once image flow separate from the message retention countdown. Viewing a consumed image must not become possible again.
- Browser regression: `npm.cmd run build` then `npm.cmd run test:e2e`. `tests/web-lifecycle.spec.mjs` uses an isolated browser fixture and controlled time.
- Human-facing setup and important commands belong in README.md. AI constraints belong here. Keep CLI.md for detailed terminal behavior and cloud/DEPLOYMENT.md as the factual deployment checkpoint.
- Git remote: `git@github.com:LeonZ03/Whisper.git`; branch: `main`. Inspect the staged file list before a commit. Use ordinary fast-forward pushes; verify local and remote commit IDs afterward.
- Generated assets, local runtime directories, logs, and machine-specific verification reports stay outside Git. A fresh clone must rebuild from the committed source and lockfile.
- Report Git synchronization and cloud deployment separately. Only a configured and verified Builds integration makes a push deploy code; it never migrates local chat data.

## Cloud deployment and operations

- Owner-approved Android persistent login (2026-09-29) may retain only a device-bound Android Keystore AES-GCM encrypted session cookie and identity private key. Never persist original passwords, authKey, plaintext login files or messages. Backgrounding clears displayed content, explicit logout clears this vault, and server revocation remains enforced. Web and CLI use only the separate approved protections documented in the three-client section above.

- The owner approved `whisper.leonz03.dpdns.org`. Do not touch BeiPiao, the root hostname or other subdomains.
- Cloud entry is `cloud/worker.mjs`; local entry remains `server/app.mjs`. Do not run the local launcher inside Workers.
- Cloud data is independent. Never import data/ or regenerate existing users' identity keys during a deployment.
- Apply only reviewed versioned migrations from cloud/migrations. Never reset, drop or recreate production tables to fix a deployment.
- D1 image claiming uses DELETE RETURNING plus an in-statement trigger; preserve the single-winner property. No asynchronous SELECT-then-clear claim.
- Read cloud/AUTHENTICATION.md before authentication changes. Preserve the client KDF and document the cloud HMAC/pepper tradeoff; no bare credential hashes.
- Runtime AUTH_PEPPER belongs in Workers Secrets. The old INVITE_CODE secret is unused by approval registration; never reintroduce it as an enrollment requirement. Never export OAuth tokens or write runtime secrets into source, build assets or public instructions.
- Keep an established AUTH_PEPPER stable. Replacing it invalidates existing password-derived verifiers; rotation requires an explicit migration design.
- Keep preview builds disabled unless their secrets and databases are isolated from production.
- Cloud build is cross-platform and downloads a SHA-256-pinned official Windows Node runtime. Never package the host project, data or credentials.
- CLI release ZIP exceeds one Static Assets file: build hash-named chunks and stream them at the original ZIP path. Verify the reconstructed ZIP hash.
- Run build:cloud, test:cloud, npm test, build and test:e2e. Production validation must not publish test credentials or disturb real accounts.
- Do not upgrade a Cloudflare plan or enable a paid product without explicit permission. Native rate limits are not a global billing guarantee.
- Record Worker deployment, domain HTTPS, runtime secrets readiness and Git-push-triggered deployment as separate verified milestones.
- Current status belongs in cloud/DEPLOYMENT.md. Never mark automatic deployment complete without an actual push and matching live commit.

- Ordinary Builds deploy with `deploy:cloud:code`. Database migrations are owner-reviewed and separate; do not silently add D1 write permissions to a build token.

## Account approval and recovery

- Registration is owner-approved and invitation-free. Do not restore direct account activation or request an invitation code.
- New passwords are 1–12 Unicode code points after NFC normalization. This is for enrollment, password changes, and recovery only; preserve login compatibility for existing longer passwords. Warn users that short passwords are weak.
- Owner bootstrap is `node scripts/manage-root.mjs --local` or `--cloud`; first password is `0000`, followed by a private one-time activation file under ignored `data/` and mandatory password change. Recovery uses the same target flag plus `--recover`. Never place activation/recovery codes in source, command arguments, logs, release assets, or public instructions.
- Member password change rewraps the same identity. Owner-issued member recovery replaces the identity, seals old conversations, and cannot restore old message decryption; safety-code rechecking is required. Explain this boundary accurately.
- Removal/rejection is soft deletion with session revocation and conversation sealing, not a promise of physical erasure. Be accurate about root login IP and estimated-location logging, application-readable request notes, and service-visible metadata.
- Deploy account changes in stages: first compatible explicit session columns and disabling the old direct-registration path; then a separately reviewed migration; then the complete code push and online verification. A code rollback must not re-enable the old registration path. Do not report any stage complete without the main task's verified milestone.
- Link README.md to SECURITY.md, whose claims must match `src/crypto.mjs` and its known limits. Keep user-facing setup concise and in Chinese.

## Verified release pipeline (2026-09-24)

- The GitHub App now includes Whisper and retains BeiPiao; never replace that list with all repositories or remove unrelated entries.
- The main-branch push `2546866` triggered Cloudflare Build `c63aa9a0`; its commit was verified at the formal HTTPS /api/health endpoint without a manual deploy.
- Ordinary pushes now update the cloud service automatically. Keep the build command's tests and the code-only deploy command; do not append production database migrations to CI.
- Keep README.md, CLI.md and cloud/DEPLOYMENT.md consistent about local versus cloud accounts and installation URLs.
- Routine tests must use isolated local data. Any explicit production acceptance must use unique synthetic identities, keep credentials only in memory, and remove exactly its own records afterward.
- Acceptance must distinguish real user records from synthetic probes. Do not claim independent-network tests or security auditing when only same-host cloud access was tested.
