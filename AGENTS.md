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
- Human-facing setup and important commands belong in README.md. AI constraints belong here. Keep CLI.md for detailed terminal behavior and the cloud deployment plan marked pending.
- Git remote: `git@github.com:LeonZ03/Whisper.git`; branch: `main`. Inspect the staged file list before a commit. Use ordinary fast-forward pushes; verify local and remote commit IDs afterward.
- Generated assets, local runtime directories, logs, and machine-specific verification reports stay outside Git. A fresh clone must rebuild from the committed source and lockfile.
- Report Git synchronization and cloud deployment separately. Pushing this repository does not start or migrate the chat service.
