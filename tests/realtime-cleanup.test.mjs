import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloud/worker.mjs';

test('empty scheduled cleanup leaves the hub asleep; expiration rechecks only the required sessions', async()=>{
  for(const [messages,sessions] of [[0,0],[1,0],[0,1]]){
    const notifications=[],pending=[];
    const env={DB:{prepare:()=>({bind(){return this;},first:async()=>({seq:10}),all:async()=>({results:messages?[{a:'test-member',b:null}]:[]})}),batch:async()=>[{meta:{changes:messages}},{meta:{changes:sessions}}]},
      REALTIME:{idFromName:()=>0,get:()=>({fetch:async request=>{notifications.push(await request.json());return new Response(null,{status:204});}})}};
    await worker.scheduled({},env,{waitUntil:promise=>pending.push(promise)});await Promise.all(pending);
    assert.equal(notifications.length,messages||sessions?1:0);
    if(notifications.length){assert.equal(notifications[0].revalidateAll,Boolean(sessions));assert.deepEqual(notifications[0].users,messages?['test-member']:[]);}
  }
});
