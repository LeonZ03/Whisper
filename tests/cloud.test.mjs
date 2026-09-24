import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cloudFixture } from './cloud-fixture.mjs';
import { WhisperClient } from '../cli/client.mjs';
import { encryptMessage } from '../src/crypto.mjs';
import { mac, validB64 } from '../cloud/security.mjs';
test('cloud credential verifier requires a separate pepper; validates envelopes',async()=>{
  const key='a'.repeat(64),credential=Buffer.alloc(32,1).toString('base64');
  assert.notEqual(await mac(key,'auth-v1','alice','salt',credential),await mac('b'.repeat(64),'auth-v1','alice','salt',credential));
  await assert.rejects(mac('',credential));assert.throws(()=>validB64('not-base64',32));
  assert.doesNotThrow(()=>validB64(credential,32));
});
test('actual Workers/D1: authentication, E2EE, atomic image claim, cleanup and static security', {timeout:180000},async()=>{
  const f=await cloudFixture(),clients=[];
  const make=()=>{const c=new WhisperClient({server:f.url});clients.push(c);return c;};
  const [a,b,c,again]=[make(),make(),make(),make()];
  try {
    for(const [client,username] of [[a,'alice_cloud'],[b,'bobby_cloud'],[c,'carol_cloud']])
      await client.authenticate({username,password:'Cloud-Isolated-Password!2026',invite:f.invite,register:true});
    await assert.rejects(again.authenticate({username:'alice_cloud',password:'wrong password'}),e=>e.status===401);
    await again.authenticate({username:'alice_cloud',password:'Cloud-Isolated-Password!2026'});
    assert.equal(again.user.publicKey,a.user.publicKey);
    await a.chat('bobby_cloud');await b.chat('alice_cloud');
    assert.equal(await a.safety(),await b.safety());
    await a.send('云端测试：明文不进入数据库');await b.sync();
    assert.equal(b.viewMessages()[0].text,'云端测试：明文不进入数据库');
    const stored=await f.db.prepare('SELECT ciphertext FROM messages').first();
    assert.ok(!stored.ciphertext.includes('云端测试'));
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
