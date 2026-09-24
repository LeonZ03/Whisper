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

## CLI maintenance

- CLI must reuse src/crypto.mjs and the existing API; no protocol downgrade or server auth bypass.
- Keep passwords, decrypted messages, private keys and cookies out of CLI arguments, history and files.
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
- Run test:cli:install and test:cli:package for installer/release changes.

## CLI interaction guarantees

- Up/Down recall only validated slash commands in memory (maximum 100); preserve the unsubmitted draft. Menu navigation takes priority. Never record chat text, passwords, invitation codes, prompt answers or invalid credential-bearing arguments.
- Clear command recall on account/server changes and exit. Do not add an on-disk history file.
- Informational command output belongs in the current conversation transcript, not a replacement chat screen. Never keep copied message bodies in command-output blocks.
- Countdowns use the existing absolute message expiry and repaint without extra network requests. Keep deletion/expiry filtering active, including for messages preceding a help block.
- Run cli-interaction unit tests plus the installed PowerShell/ConPTY regression for changes to these behaviors.

## Web lifecycle and repository maintenance

- `src/message-lifecycle.mjs` owns the browser countdown and disappearance effect. Countdown uses the existing absolute expiry, never a new lifetime starting at render time.
- Reuse message DOM nodes across polls. Timer ticks update only changed labels and must preserve input focus, drafts, and reading position.
- Clear the message content before animating the empty shell. Respect reduced motion; cancel timers and effects on conversation changes, logout, and disconnection.
- Keep the ten-second view-once image flow separate from the message retention countdown. Viewing a consumed image must not become possible again.
- Browser regression: `npm.cmd run build` then `npm.cmd run test:e2e`. `tests/web-lifecycle.spec.mjs` uses an isolated browser fixture and controlled time.
- Human-facing setup and important commands belong in README.md. AI constraints belong here. Keep CLI.md for detailed terminal behavior and cloud/DEPLOYMENT.md as the factual deployment checkpoint.
- Git remote: `git@github.com:LeonZ03/Whisper.git`; branch: `main`. Inspect the staged file list before a commit. Use ordinary fast-forward pushes; verify local and remote commit IDs afterward.
- Generated assets, local runtime directories, logs, and machine-specific verification reports stay outside Git. A fresh clone must rebuild from the committed source and lockfile.
- Report Git synchronization and cloud deployment separately. Only a configured and verified Builds integration makes a push deploy code; it never migrates local chat data.

## Cloud deployment and operations

- The owner approved `whisper.leonz03.dpdns.org`. Do not touch BeiPiao, the root hostname or other subdomains.
- Cloud entry is `cloud/worker.mjs`; local entry remains `server/app.mjs`. Do not run the local launcher inside Workers.
- Cloud data is independent. Never import data/ or regenerate existing users' identity keys during a deployment.
- Apply only reviewed versioned migrations from cloud/migrations. Never reset, drop or recreate production tables to fix a deployment.
- D1 image claiming uses DELETE RETURNING plus an in-statement trigger; preserve the single-winner property. No asynchronous SELECT-then-clear claim.
- Read cloud/AUTHENTICATION.md before authentication changes. Preserve the client KDF and document the cloud HMAC/pepper tradeoff; no bare credential hashes.
- Runtime AUTH_PEPPER and INVITE_CODE belong in Workers Secrets. Never export OAuth tokens or write runtime secrets into source, build assets or public instructions.
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
