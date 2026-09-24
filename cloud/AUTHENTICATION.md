# Cloud authentication and storage boundary

This is a new empty cloud deployment, not a migration of local accounts.
The E2EE protocol and `src/crypto.mjs` are unchanged. This document is a design
record, not an independent security audit.

## Credential verification

The browser/CLI still runs PBKDF2-HMAC-SHA256 with 600,000 iterations and a
per-user 16-byte salt, then uses domain-separated HKDF for the 256-bit `authKey`
and the vault encryption key. Only `authKey` is submitted over HTTPS. The vault
key and decrypted identity private key remain on the client.

The local server's additional scrypt verification needs about 128 MiB before
runtime overhead. Cloud Workers cannot safely run that within a 128 MB isolate.
The cloud server instead treats `authKey` as a password-derived authentication
credential and stores a domain-separated HMAC-SHA256 verifier, using a random
32-byte server pepper stored in Workers Secrets, a per-account random salt,
and the username. It does NOT store a bare hash or the reusable `authKey`.

A database-only attacker cannot check the HMAC without the separate pepper.
The encrypted vault is still an offline password-guessing target: its protection
remains the same 600,000-iteration client KDF, even on the local implementation.
An attacker obtaining both the pepper and database can test guesses after that
client KDF; the extra local scrypt work factor is NOT present in the cloud.
This explicit tradeoff is not a claim of cryptographic equivalence. Long unique
passwords, invitation-only registration, rate limits and endpoint security remain
necessary. Never reduce the client KDF or expose AUTH_PEPPER to browser/build assets.

## Operational rules

AUTH_PEPPER must remain stable across code deployments. Replacing it changes
all account verifiers and requires a separate recovery/migration design. Never
reuse this pepper as an invitation code, cookie token or client encryption key.
Session tokens are random; only their SHA-256 hashes are stored in D1. Expiry and
revocation are checked on each authenticated request. Cookies remain host-only,
HttpOnly, SameSite=Strict, and Secure on HTTPS.

Native Workers rate limits apply by edge location and are not an exact global
abuse or spending limit. Registration is capped at 50 accounts, stored messages
at 10,000 and encrypted payload bytes at 300,000,000. These caps do not replace
Cloudflare request/CPU/storage quotas or operational monitoring.

D1 Time Travel can retain ciphertext that has been removed from active tables.
A backup restore may resurrect previously deleted messages or consumed image
payloads. Do not expose a restored database without a reviewed procedure that
prevents those historical payloads from being served again. This first release
does not automate production backup restores or claim irreversible erasure.

References (recheck before changing runtime assumptions):
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback
