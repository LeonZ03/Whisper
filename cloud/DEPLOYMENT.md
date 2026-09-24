# Cloud deployment runbook

## Current checkpoint (2026-09-24)

Cloudflare Worker `whisper` was published successfully with Static Assets and the
D1 binding `DB`. The independent database `whisper-production` has migration
`0001_initial.sql` applied. No local accounts or messages were imported.

The approved production hostname is `whisper.leonz03.dpdns.org`. Its custom-domain
binding is complete. GitHub Builds connection has NOT yet been completed or verified.
The initial Worker endpoint is `https://whisper.2279746395.workers.dev`.

Runtime authentication secrets have been initialized through official Wrangler stdin.
The server pepper was never written to local files or terminal output. The new
cloud invitation is in ignored data/cloud-invite-code.txt. Full live acceptance
and push-triggered deployment verification are still pending.

## Runtime secrets (owner-controlled)

In Cloudflare: Workers & Pages → whisper → Settings → Variables and Secrets.
Add both entries as **Secret**, not plaintext variables and not build variables:

| Name | Required value |
| --- | --- |
| `AUTH_PEPPER` | A cryptographically random 32-byte value encoded as 64 lowercase hexadecimal characters. Keep it private and stable. |
| `INVITE_CODE` | A new, unpredictable invitation code used only for the cloud instance. Share only with intended invitees. |

Use your password manager's random generator or a reviewed local cryptographic
random generator. Do not reuse the documented test values or paste secrets into
chat, Git, logs, screenshots, or `wrangler.jsonc`. Deploy the Secret changes.

## Confirmed infrastructure update

The custom domain `whisper.leonz03.dpdns.org` is now bound to the `whisper`
Worker by Wrangler. This supersedes the domain-pending statement above.
DNS/HTTPS reachability still needs its final external check. BeiPiao is unchanged.

## GitHub automatic builds

Connect the existing Worker, not a new Pages project:
Workers & Pages → whisper → Settings → Builds → Connect.
Select GitHub repository `LeonZ03/Whisper` and production branch `main`.

| Setting | Value |
| --- | --- |
| Worker name | `whisper` (must match wrangler.jsonc) |
| Root directory | repository root |
| Build command | `npm test && npm run build:cloud && npm run test:cloud` |
| Deploy command | `npm run deploy:cloud:code` |
| Build variable | `.node-version` pins `24.16.0`; no runtime Secret is a build variable |
| Preview/non-production builds | Disabled until separate test databases are configured |

The build token needs Worker deployment permissions; ordinary builds do not need D1 write permission.
Do not put AUTH_PEPPER or INVITE_CODE into the build environment. Runtime
Secrets are managed separately. Never commit or copy the Wrangler OAuth token.
Automatic deployment changes code only. The initial migration is already applied.
Later schema changes require an owner-reviewed `npm run db:migrate:cloud` before
the compatible code release. Never recreate the database or import local data.

The one-time owner setup script is scripts/initialize-cloud-secrets.mjs. It refuses
to overwrite an existing secret. Do not run it during builds or routine deployments.

## GitHub installation access checkpoint

On 2026-09-24, the owner completed GitHub's identity confirmation. The existing
Cloudflare Workers and Pages GitHub App previously selected only BeiPiao.
Whisper was added to that selected-repositories list without removing BeiPiao
or granting access to all repositories. GitHub saved the installation change.
Cloudflare now shows LeonZ03/Whisper without its disconnected-account warning.
The production branch is main, and the previously recorded build/deploy commands
were re-read from the dashboard. A real push-triggered deployment and live data
persistence acceptance are the next checkpoint; saving the connection alone is
not proof that an automated release succeeded.
