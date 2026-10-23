import test from 'node:test';
import assert from 'node:assert/strict';
import { AndroidRealtimeConnection } from '../android/web/realtime.mjs';
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
test('native bridge preserves one socket across pause and repairs on resume without background sync', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts=0,stops=0,changes=0,revoked=0;
  const state={userId:'alice',state:'open',revision:1,revoked:false,suppressed:false};
  globalThis.whisperAndroidSessionRevoked=()=>revoked++;
  const bridge={startRealtime:(id,key)=>{assert.equal(id,'alice');assert.equal(key,'public');starts++;},stopRealtime:()=>stops++,realtimeState:()=>JSON.stringify(state)};
  const client=new AndroidRealtimeConnection({user:{id:'alice',publicKey:'public'},bridge,onChange:async()=>changes++,onState:()=>{}});
  t.after(()=>{client.stop();delete globalThis.whisperAndroidSessionRevoked;});
  await client.start(); await client.start(); assert.equal(starts,1); assert.equal(changes,1);
  client.pause(); state.revision=2; globalThis.whisperAndroidRealtimeEvent({...state});
  t.mock.timers.tick(90000); await flush(); assert.equal(changes,1);assert.equal(stops,0);
  await client.resume(); assert.equal(starts,1); // app foreground sync separately catches all missed events
  state.revision=3;globalThis.whisperAndroidRealtimeEvent({...state});await flush();assert.equal(changes,2);
  globalThis.whisperAndroidRealtimeEvent({...state,userId:'old-account',revoked:true}); assert.equal(revoked,0);
  globalThis.whisperAndroidRealtimeEvent({...state,revoked:true}); assert.equal(revoked,1);
  client.stop(); state.revision=4;globalThis.whisperAndroidRealtimeEvent({...state});
  t.mock.timers.tick(90000);await flush();assert.equal(changes,2);assert.equal(stops,0);
});
test('late native startup snapshot cannot revive a stopped account controller',async()=>{
  let resolve,starts=0;
  const bridge={realtimeState:()=>new Promise(r=>resolve=r),startRealtime:()=>starts++};
  const client=new AndroidRealtimeConnection({user:{id:'alice',publicKey:'public'},bridge,onChange:()=>{},onState:()=>{}});
  const starting=client.start();client.stop();resolve(JSON.stringify({userId:'alice',suppressed:false}));await starting;
  assert.equal(starts,0);
});
test('failed native startup retries at bounded foreground intervals, never while paused or opted out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts=0,changes=0;
  const state={userId:'alice',state:'stopped',revision:0,revoked:false,suppressed:false};
  const bridge={realtimeState:()=>JSON.stringify(state),startRealtime:()=>starts++};
  const client=new AndroidRealtimeConnection({user:{id:'alice',publicKey:'public'},bridge,onChange:async()=>changes++,onState:()=>{}});
  t.after(()=>client.stop());
  await client.start();assert.equal(starts,1);
  t.mock.timers.tick(29999);await flush();assert.equal(starts,1);
  t.mock.timers.tick(15002);await flush();assert.equal(starts,2);
  client.pause();t.mock.timers.tick(180000);await flush();assert.equal(starts,2);
  await client.resume();assert.equal(starts,3);
  state.state='open';state.revision++;globalThis.whisperAndroidRealtimeEvent({...state});
  t.mock.timers.tick(45001);await flush();assert.equal(starts,3);
  client.pause();state.suppressed=true;await client.resume();
  // Suppressed mode may open a foreground-only fallback; it cannot restart the native service.
  t.mock.timers.tick(90001);await flush();assert.equal(starts,3);assert.ok(changes>0);
});
