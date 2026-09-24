import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhisperServer } from '../server/app.mjs';
import { prepareOwnerMaterial } from '../accounts/owner-material.mjs';
import { prepareEnrollment, preparePasswordChange } from '../src/account-client.mjs';
import { deriveCredentials, b64, wipe, safetyCode } from '../src/crypto.mjs';
import { WhisperClient } from '../cli/client.mjs';

test('owner gating, approval, identity-preserving change, one-time recovery and removal', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-account-flow-'));
  const app = await createWhisperServer({ port: 0, dataDir: dir });
  const url = app.localUrl;
  const clients = [];
  async function request(path, method = 'GET', body, cookie) {
    const response = await fetch(url + path, { method, headers: {
      ...(method === 'GET' ? {} : { Origin: url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' }),
      ...(cookie ? { Cookie: cookie } : {})
    }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const fresh = () => { const client = new WhisperClient({ server: url }); clients.push(client); return client; };
  const rootOld = 'RootTemp42', rootNew = 'RootRenew42';
  try {
    const owner = await prepareOwnerMaterial(rootOld), r = owner.row;
    app.db.prepare("INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,auth_scheme,created_at,role,status,must_change) VALUES(?,'root',?,?,?,?,?,?,'root-bootstrap-hmac-v1',?,'root','active',1)")
      .run(r.id, r.publicKey, r.salt, r.vault.nonce, r.vault.ciphertext, r.authSalt, r.authHash, Date.now());
    const initial = await deriveCredentials(rootOld, r.salt);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'root', authKey: b64(initial.authKey) })).status, 401);
    const rootLogin = await request('/api/auth/login', 'POST', { username: 'root', authKey: b64(initial.authKey), activationCode: owner.activationCode });
    assert.equal(rootLogin.status, 200);
    assert.equal(rootLogin.data.mustChangePassword, true);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'root', authKey: b64(initial.authKey), activationCode: owner.activationCode })).status, 409);
    assert.equal((await request('/api/admin/members', 'GET', undefined, rootLogin.cookie)).status, 403);
    const rootChange = await preparePasswordChange(rootLogin.data, rootOld, rootNew);
    rootChange.activationCode = owner.activationCode;
    assert.equal((await request('/api/account/password', 'POST', rootChange, rootLogin.cookie)).status, 200);
    assert.equal((await request('/api/account/me', 'GET', undefined, rootLogin.cookie)).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'root', authKey: b64(initial.authKey) })).status, 401);
    wipe(initial.authKey); wipe(initial.vaultKey);
    const next = await deriveCredentials(rootNew, rootChange.salt);
    const admin = await request('/api/auth/login', 'POST', { username: 'root', authKey: b64(next.authKey) });
    assert.equal(admin.status, 200);
    assert.equal(admin.data.mustChangePassword, false);
    const adminAction = async (id, kind, username, version) => request(`/api/admin/members/${id}/${kind}`, 'POST', {
      currentAuthKey: b64(next.authKey), confirmUsername: username, credentialVersion: version
    }, admin.cookie);

    const alice = fresh(), bob = fresh(), oldAlice = fresh();
    const aliceOld = 'AliceTemp42', aliceNew = 'AliceRenew42', bobOld = 'BobTemp42';
    assert.equal((await alice.authenticate({ username: 'alice_flow', password: aliceOld, register: true })).pending, true);
    assert.equal((await bob.authenticate({ username: 'bobby_flow', password: bobOld, register: true })).pending, true);
    await assert.rejects(alice.authenticate({ username: 'alice_flow', password: aliceOld }), e => e.status === 403);
    const pending = await request('/api/admin/members', 'GET', undefined, admin.cookie);
    assert.equal(pending.status, 200);
    assert.equal(pending.data.members.filter(m => m.status === 'pending').length, 2);
    for (const member of pending.data.members.filter(m => m.status === 'pending')) {
      assert.equal((await adminAction(member.id, 'approve', member.username, member.credentialVersion)).status, 200);
    }
    await alice.authenticate({ username: 'alice_flow', password: aliceOld });
    await bob.authenticate({ username: 'bobby_flow', password: bobOld });
    await oldAlice.authenticate({ username: 'alice_flow', password: aliceOld });
    assert.equal((await request('/api/admin/logins', 'GET', undefined, oldAlice.cookie)).status, 403);
    assert.equal((await request('/api/admin/members', 'GET', undefined, oldAlice.cookie)).status, 403);
    await alice.chat('bobby_flow'); await bob.chat('alice_flow');
    const oldCode = await safetyCode(alice.user, bob.user), originalKey = alice.user.publicKey;
    await alice.send('synthetic-account-flow-message'); await bob.sync();
    assert.equal(bob.viewMessages().at(-1).text, 'synthetic-account-flow-message');
    const aliceMe = await request('/api/account/me', 'GET', undefined, alice.cookie);
    const change = await preparePasswordChange(aliceMe.data, aliceOld, aliceNew);
    assert.equal((await request('/api/account/password', 'POST', change, alice.cookie)).status, 200);
    assert.equal((await request('/api/conversations', 'GET', undefined, oldAlice.cookie)).status, 401);
    await assert.rejects(fresh().authenticate({ username: 'alice_flow', password: aliceOld }), e => e.status === 401);
    const renewedAlice = fresh(); await renewedAlice.authenticate({ username: 'alice_flow', password: aliceNew });
    assert.equal(renewedAlice.user.publicKey, originalKey);
    assert.equal(await safetyCode(renewedAlice.user, bob.user), oldCode);
    await renewedAlice.chat('bobby_flow'); await renewedAlice.sync();
    assert.equal(renewedAlice.viewMessages().at(-1).text, 'synthetic-account-flow-message');

    const member = app.db.prepare("SELECT id,credential_version FROM users WHERE username='bobby_flow'").get();
    const reset = await adminAction(member.id, 'reset', 'bobby_flow', member.credential_version);
    assert.equal(reset.status, 200);
    assert.match(reset.data.recoveryCode, /^WR-/);
    assert.equal((await request('/api/conversations', 'GET', undefined, bob.cookie)).status, 401);
    const recovered = await prepareEnrollment('BobRenew42');
    const recovery = { username: 'bobby_flow', recoveryCode: reset.data.recoveryCode, ...recovered };
    const claims = await Promise.all([request('/api/auth/recover', 'POST', recovery), request('/api/auth/recover', 'POST', recovery)]);
    assert.equal(claims.filter(v => v.status === 200).length, 1);
    assert.equal((await request('/api/auth/recover', 'POST', recovery)).status, 403);
    const newBob = fresh(); await newBob.authenticate({ username: 'bobby_flow', password: 'BobRenew42' });
    assert.notEqual(newBob.user.publicKey, bob.user.publicKey);
    assert.notEqual(await safetyCode(renewedAlice.user, newBob.user), oldCode);
    await newBob.chat('alice_flow'); await newBob.sync();
    assert.equal(newBob.viewMessages().length, 0);
    await renewedAlice.sync(); assert.equal(renewedAlice.trust().blocked, true);

    const aliceRow = app.db.prepare("SELECT id,credential_version FROM users WHERE username='alice_flow'").get();
    assert.equal((await adminAction(aliceRow.id, 'remove', 'alice_flow', aliceRow.credential_version)).status, 200);
    assert.equal((await request('/api/conversations', 'GET', undefined, renewedAlice.cookie)).status, 401);
    const logins = await request('/api/admin/logins', 'GET', undefined, admin.cookie);
    assert.equal(logins.status, 200); assert.ok(logins.data.rows.some(row => row.result === 'success_initial'));
    assert.ok(logins.data.rows.some(row => row.result === 'failed'));
    const actions = app.db.prepare('SELECT action FROM admin_audit ORDER BY seq').all().map(row => row.action);
    assert.ok(actions.includes('reset_issued')); assert.ok(actions.includes('remove'));
    wipe(next.authKey); wipe(next.vaultKey);
  } finally {
    await Promise.all(clients.map(client => client.logout().catch(() => {})));
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
});
