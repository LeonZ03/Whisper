import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ready, randomSalt, deriveCredentials, createIdentity, unlockIdentity, encryptMessage, decryptMessage, encryptImagePreview, decryptImagePreview, safetyCode, wipe } from '../src/crypto.mjs';
await ready;
test('encrypted coarse preview is bound to identity, message, purpose and expiry', () => {
  const a = { id: randomUUID(), ...createIdentity(new Uint8Array(32)) }, b = { id: randomUUID(), ...createIdentity(new Uint8Array(32)) };
  const conversationId = randomUUID(), wire = { ...encryptMessage(a, b, conversationId, 'original', { type: 'image' }), senderId: a.id, conversationId };
  const preview = { width: 8, height: 5, pixels: new Uint8Array(120).fill(17) };
  wire.preview = encryptImagePreview(wire, a, b, conversationId, preview);
  assert.notEqual(wire.nonce, wire.preview.nonce);
  assert.deepEqual(decryptImagePreview(wire, b, a), preview);
  assert.deepEqual(decryptImagePreview(wire, a, b), preview);
  assert.throws(() => decryptMessage({ ...wire, ...wire.preview }, b, a));
  assert.throws(() => decryptImagePreview({ ...wire, preview: { nonce: wire.nonce, ciphertext: wire.ciphertext } }, b, a));
  for (const change of [{ id: randomUUID() }, { conversationId: randomUUID() }, { expiresAt: wire.expiresAt + 1 }, { consumedAt: Date.now() }]) {
    assert.throws(() => decryptImagePreview({ ...wire, ...change }, b, a));
  }
  assert.throws(() => decryptImagePreview({ ...wire, id: randomUUID(), preview: { ...wire.preview, id: wire.id } }, b, a));
  wipe(a.secretKey); wipe(b.secretKey);
});
test('密钥封装、密码派生分离、双向加解密、第三方隔离、篡改检测、安全码一致', async () => {
  const salt = randomSalt(); const credentials = await deriveCredentials('Test-only-long-password-203!', salt);
  assert.notDeepEqual(credentials.authKey, credentials.vaultKey);
  const a = { id: randomUUID(), ...createIdentity(credentials.vaultKey) };
  const b = { id: randomUUID(), ...createIdentity(credentials.vaultKey) };
  const c = { id: randomUUID(), ...createIdentity(credentials.vaultKey) };
  assert.deepEqual(unlockIdentity(a, credentials.vaultKey), a.secretKey);
  assert.throws(() => unlockIdentity(a, new Uint8Array(32)));
  const conversationId = randomUUID();
  const plaintext = '只在浏览器解密 <script>alert(1)</script>';
  const wire = { ...encryptMessage(a, b, conversationId, plaintext), senderId: a.id, conversationId };
  const repeated = encryptMessage(a, b, conversationId, plaintext);
  assert.notEqual(wire.ciphertext, repeated.ciphertext);
  assert.equal(Buffer.from(wire.ciphertext, 'base64').includes(Buffer.from(plaintext)), false);
  assert.equal(decryptMessage(wire, b, a).body, plaintext);
  assert.equal(decryptMessage(wire, a, b).body, plaintext);
  assert.throws(() => decryptMessage(wire, c, a));
  assert.throws(() => decryptMessage({ ...wire, id: randomUUID() }, b, a));
  const damaged = Buffer.from(wire.ciphertext, 'base64'); damaged[0] ^= 1;
  assert.throws(() => decryptMessage({ ...wire, ciphertext: damaged.toString('base64') }, b, a));
  assert.equal(await safetyCode(a, b), await safetyCode(b, a));
  assert.notEqual(await safetyCode(a, b), await safetyCode(a, c));
  wipe(a.secretKey); wipe(b.secretKey); wipe(c.secretKey); wipe(credentials.authKey); wipe(credentials.vaultKey);
});
