import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cloudFixture } from './cloud-fixture.mjs';
import { WhisperClient } from '../cli/client.mjs';
import { encryptMessage } from '../src/crypto.mjs';
import { mac, validB64 } from '../cloud/security.mjs';
import { prepareOwnerMaterial } from '../accounts/owner-material.mjs';
import { preparePasswordChange } from '../src/account-client.mjs';
import { deriveCredentials, b64, wipe } from '../src/crypto.mjs';
test('cloud credential verifier requires a separate pepper; validates envelopes',async()=>{
  const key='a'.repeat(64),credential=Buffer.alloc(32,1).toString('base64');
  assert.notEqual(await mac(key,'auth-v1','alice','salt',credential),await mac('b'.repeat(64),'auth-v1','alice','salt',credential));
  await assert.rejects(mac('',credential));assert.throws(()=>validB64('not-base64',32));
  assert.doesNotThrow(()=>validB64(credential,32));
});
test('D1 root activation is single-use and success audit commits with session', { timeout: 120000 }, async () => {
  const f = await cloudFixture();
  const initialPassword = 'CloudRoot0', nextPassword = 'CloudRoot1';
  const owner = await prepareOwnerMaterial(initialPassword), r = owner.row;
  const request = async (path, body, cookie) => {
    const response = await fetch(f.url + path, { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    await f.db.prepare("INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,auth_scheme,created_at,role,status,must_change) VALUES(?,'root',?,?,?,?,?,?,'root-bootstrap-hmac-v1',?,'root','active',1)")
      .bind(r.id, r.publicKey, r.salt, r.vault.nonce, r.vault.ciphertext, r.authSalt, r.authHash, Date.now()).run();
    const old = await deriveCredentials(initialPassword, r.salt);
    const login = { username: 'root', authKey: b64(old.authKey), activationCode: owner.activationCode };
    const first = await request('/api/auth/login', login);
    assert.equal(first.status, 200);
    assert.equal((await request('/api/auth/login', login)).status, 409);
    assert.equal((await f.db.prepare('SELECT root_activation_consumed FROM users WHERE id=?').bind(r.id).first()).root_activation_consumed, 1);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM root_login_log WHERE result='success_initial'").first()).n, 1);
    const change = await preparePasswordChange(first.data, initialPassword, nextPassword);
    change.activationCode = owner.activationCode;
    assert.equal((await request('/api/account/password', change, first.cookie)).status, 200);
    const newer = await deriveCredentials(nextPassword, change.salt);
    assert.equal((await request('/api/auth/login', { username: 'root', authKey: b64(newer.authKey) })).status, 200);
    wipe(old.authKey); wipe(old.vaultKey); wipe(newer.authKey); wipe(newer.vaultKey);
  } finally { await f.close(); }
});
test('actual Workers/D1: authentication, E2EE, atomic image claim, cleanup and static security', {timeout:180000},async()=>{
  const f=await cloudFixture(),clients=[];
  const make=()=>{const c=new WhisperClient({server:f.url});clients.push(c);return c;};
  const [a,b,c,again]=[make(),make(),make(),make()];
  try {
    for(const [client,username] of [[a,'alice_cloud'],[b,'bobby_cloud'],[c,'carol_cloud']]) {
      const result=await client.authenticate({username,password:'CloudTest26!',register:true});
      assert.equal(result.pending,true);
      await f.approve(username);
      await client.authenticate({username,password:'CloudTest26!'});
    }
    await assert.rejects(again.authenticate({username:'alice_cloud',password:'wrong password'}),e=>e.status===401);
    await again.authenticate({username:'alice_cloud',password:'CloudTest26!'});
    assert.equal(again.user.publicKey,a.user.publicKey);
    await a.chat('bobby_cloud');await b.chat('alice_cloud');
    assert.equal(await a.safety(),await b.safety());
    const probe = '云端测试：明文不进入数据库';
    const originalRequest = a.request.bind(a);
    a.request = (path, method, body) => {
      if (method === 'POST' && path.endsWith('/messages')) {
        assert.equal(JSON.stringify(body).includes(probe), false);
        assert.equal(Buffer.from(body.ciphertext, 'base64').includes(Buffer.from(probe)), false);
      }
      return originalRequest(path, method, body);
    };
    await a.send(probe);await b.sync();
    a.request = originalRequest;
    assert.equal(b.viewMessages()[0].text,probe);
    const stored=await f.db.prepare('SELECT ciphertext FROM messages').first();
    assert.equal(stored.ciphertext.includes(probe), false);
    assert.equal(Buffer.from(stored.ciphertext, 'base64').includes(Buffer.from(probe)), false);
    await assert.rejects(c.request(`/api/conversations/${a.selected.id}/messages`),e=>e.status===404);
    await assert.rejects(c.request(`/api/conversations/${a.selected.id}/history?beforeSeq=999`),e=>e.status===404);
    const denied=await fetch(f.url+'/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(denied.status,403);
    await assert.rejects(a.request('/api/conversations','POST',{username:'bobby_cloud',members:['carol_cloud']}),e=>e.status===400);
    const image=encryptMessage(a.user,a.selected.peer,a.selected.id,'AA==',{type:'image',mime:'image/png'});
    await a.request(`/api/conversations/${a.selected.id}/messages`,'POST',image);
    await assert.rejects(a.request(`/api/messages/${image.id}/open`,'POST'),e=>e.status===403);
    await assert.rejects(c.request(`/api/messages/${image.id}/open`,'POST'),e=>e.status===404);
    const claims=await Promise.allSettled(Array.from({length:8},()=>b.request(`/api/messages/${image.id}/open`,'POST')));
    assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(await f.db.prepare('SELECT * FROM image_payloads WHERE message_id=?').bind(image.id).first(),null);
    assert.ok((await f.db.prepare('SELECT consumed_at FROM messages WHERE id=?').bind(image.id).first()).consumed_at);
    await a.sync();await a.clear(a.selected.id,Math.max(...a.messages.map(m=>m.seq)));await b.sync();assert.equal(b.messages.length,0);
    const totals=await f.db.prepare('SELECT * FROM storage_totals').first();assert.equal(totals.messages,0);assert.equal(totals.bytes,0);
    const soon=encryptMessage(a.user,a.selected.peer,a.selected.id,'short-lived',{ttlMs:250});
    await a.request(`/api/conversations/${a.selected.id}/messages`,'POST',soon);
    await new Promise(r=>setTimeout(r,350));await b.sync();assert.equal(b.messages.length,0);
    const html=await fetch(f.url+'/');assert.equal(html.status,200);assert.ok(html.headers.get('Content-Security-Policy').includes("script-src 'self'"));
    const binary=await fetch(f.url+'/downloads/whisper-cli-windows-x64.zip');assert.equal(binary.status,200);
    const bytes=Buffer.from(await binary.arrayBuffer()),manifest=JSON.parse(readFileSync('.cloud/public/downloads/manifest.json'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
    assert.equal(bytes.length,manifest.bytes);
    await again.logout();await assert.rejects(again.request('/api/conversations'),e=>e.status===401);
  }finally{await Promise.all(clients.map(c=>c.logout().catch(()=>{})));await f.close();}
});
