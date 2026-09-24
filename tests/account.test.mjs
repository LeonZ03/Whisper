import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWhisperServer } from '../server/app.mjs';
import { validateNewPassword } from '../src/account-client.mjs';

const random = n => randomBytes(n).toString('base64');
test('account applications stay pending, reserve root, enforce password boundaries and gate admin APIs', async () => {
  assert.equal(validateNewPassword('🔐'.repeat(12)), 12);
  assert.throws(() => validateNewPassword(''), /1–12/);
  assert.throws(() => validateNewPassword('🔐'.repeat(13)), /1–12/);
  const dir = mkdtempSync(join(tmpdir(), 'whisper-account-test-'));
  const app = await createWhisperServer({ port: 0, dataDir: dir }); const url = app.localUrl;
  const request = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(url + path, { method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Whisper-Request': '1', Origin: url } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const envelope = username => ({ username, passwordLength: 8, authKey: random(32), publicKey: random(32), salt: random(16), vault: { nonce: random(24), ciphertext: random(48) } });
  try {
    assert.equal((await request('/api/auth/register', 'POST', envelope('root'))).status, 400);
    const member = envelope('member_test');
    const application = await request('/api/auth/register', 'POST', member);
    assert.equal(application.status, 202); assert.equal(application.data.pending, true);
    assert.equal((await request('/api/auth/register', 'POST', member)).status, 409);
    assert.equal((await request('/api/auth/login', 'POST', { username: member.username, authKey: member.authKey })).status, 403);
    assert.equal((await request('/api/admin/members')).status, 401);
    app.db.prepare("UPDATE users SET status='active', reviewed_at=? WHERE username=?").run(Date.now(), member.username);
    const login = await request('/api/auth/login', 'POST', { username: member.username, authKey: member.authKey });
    assert.equal(login.status, 200);
    assert.equal((await request('/api/admin/members', 'GET', undefined, login.cookie)).status, 403);
    const bad = envelope('forbidden_role'); bad.role = 'root';
    assert.equal((await request('/api/auth/register', 'POST', bad)).status, 400);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
