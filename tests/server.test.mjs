import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWhisperServer } from '../server/app.mjs';
const random = (n) => randomBytes(n).toString('base64');
test('邀请门禁、认证、CSRF、固定双人权限、密文存储、阅后原子清理、删除、过期', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-api-test-')); const app = await createWhisperServer({ port: 0, dataDir: dir });
  const url = app.localUrl;
  async function request(path, method = 'GET', body, cookie, origin = url) {
    const res = await fetch(url + path, { method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Whisper-Request': '1', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
  }
  const registration = (username) => ({ username, invite: app.inviteCode, authKey: random(32), publicKey: random(32), salt: random(16), vault: { nonce: random(24), ciphertext: random(48) } });
  try {
    assert.equal((await request('/api/health')).status, 200);
    assert.equal((await request('/api/conversations')).status, 401);
    const bad = registration('blocked'); bad.invite = 'wrong'; assert.equal((await request('/api/auth/register', 'POST', bad)).status, 403);
    const inputs = ['alice', 'bobby', 'carol'].map(registration); const users = [];
    for (const input of inputs) { const result = await request('/api/auth/register', 'POST', input); assert.equal(result.status, 201); users.push(result); }
    const [a, b, c] = users;
    assert.equal((await request('/api/auth/login', 'POST', { username: 'alice', authKey: random(32) })).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'alice', authKey: inputs[0].authKey })).status, 200);
    assert.equal((await request('/api/conversations', 'POST', { username: 'bobby' }, a.cookie, 'https://evil.example')).status, 403);
    assert.equal((await request('/api/conversations', 'POST', { username: 'bobby', members: ['carol'] }, a.cookie)).status, 400);
    const conv = await request('/api/conversations', 'POST', { username: 'bobby' }, a.cookie); assert.equal(conv.status, 200); const id = conv.data.id;
    assert.equal((await request(`/api/conversations/${id}/messages`, 'GET', undefined, c.cookie)).status, 404);
    const msg = { id: randomUUID(), type: 'text', nonce: random(24), ciphertext: random(100), expiresAt: Date.now() + 60000 };
    assert.equal((await request(`/api/conversations/${id}/messages`, 'POST', msg, a.cookie)).status, 201);
    assert.equal((await request(`/api/conversations/${id}/messages`, 'POST', msg, a.cookie)).status, 409);
    assert.equal((await request(`/api/conversations/${id}/messages`, 'GET', undefined, b.cookie)).data[0].ciphertext, msg.ciphertext);
    assert.equal((await request(`/api/messages/${msg.id}`, 'DELETE', {}, c.cookie)).status, 404);
    assert.equal((await request(`/api/messages/${msg.id}`, 'DELETE', {}, b.cookie)).status, 200);
    assert.equal((await request(`/api/conversations/${id}/messages`, 'GET', undefined, a.cookie)).data.length, 0);
    const image = { ...msg, id: randomUUID(), type: 'image', ciphertext: random(200) };
    await request(`/api/conversations/${id}/messages`, 'POST', image, a.cookie);
    assert.equal((await request(`/api/conversations/${id}/messages`, 'GET', undefined, b.cookie)).data[0].ciphertext, null);
    assert.equal((await request(`/api/messages/${image.id}/open`, 'POST', {}, a.cookie)).status, 403);
    assert.equal((await request(`/api/messages/${image.id}/open`, 'POST', {}, c.cookie)).status, 404);
    const opens = await Promise.all([request(`/api/messages/${image.id}/open`, 'POST', {}, b.cookie), request(`/api/messages/${image.id}/open`, 'POST', {}, b.cookie)]);
    assert.deepEqual(opens.map((r) => r.status).sort(), [200, 410]);
    assert.equal(opens.find((r) => r.status === 200).data.ciphertext, image.ciphertext);
    assert.equal(app.db.prepare('SELECT ciphertext FROM messages WHERE id=?').get(image.id).ciphertext, null);
    const row = app.db.prepare('SELECT seq FROM messages WHERE id=?').get(image.id);
    await request(`/api/conversations/${id}/clear`, 'POST', { throughSeq: row.seq }, b.cookie);
    assert.equal((await request(`/api/conversations/${id}/messages`, 'GET', undefined, a.cookie)).data.length, 0);
    const expired = { ...msg, id: randomUUID(), expiresAt: Date.now() - 1 }; assert.equal((await request(`/api/conversations/${id}/messages`, 'POST', expired, a.cookie)).status, 400);
    assert.ok((await request('/api/health')).headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    const dbBytes = readFileSync(join(dir, 'whisper.sqlite')); assert.equal(dbBytes.includes(Buffer.from(inputs[0].authKey)), false);
    assert.equal((await request('/api/auth/logout', 'POST', {}, a.cookie)).status, 200);
    assert.equal((await request('/api/conversations', 'GET', undefined, a.cookie)).status, 401);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
