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
| Deploy command | `npm run deploy:cloud` |
| Build variable | `NODE_VERSION=24.16.0` |
| Preview/non-production builds | Disabled until separate test databases are configured |

The build token must have Worker deployment and D1 migration permissions.
Do not put AUTH_PEPPER or INVITE_CODE into the build environment. Runtime
Secrets are managed separately. Never commit or copy the Wrangler OAuth token.
The deployment command only applies pending, versioned migrations; it does not
recreate the database, reset accounts or import data/whisper.sqlite.

The one-time owner setup script is scripts/initialize-cloud-secrets.mjs. It refuses
to overwrite an existing secret. Do not run it during builds or routine deployments.
