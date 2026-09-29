// Isolated workerd/D1 comparison. Never accepts a remote origin or real account.
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { encryptMessage } from '../src/crypto.mjs';

const mode = process.argv.includes('--baseline') ? 'baseline' : 'realtime';
const diagnostic = process.argv.includes('--diagnostic'), duration = diagnostic ? 1000 : 60000, samples = diagnostic ? 3 : 30;
const workerPath = resolve(mode === 'baseline' ? '.runtime/realtime-baseline/worker.mjs' : '.cloud/worker.mjs');
const { WhisperClient } = await import(pathToFileURL(resolve(mode === 'baseline' ? '.runtime/realtime-baseline/client.mjs' : 'cli/client.mjs')));
const work = mkdtempSync(join(tmpdir(), 'whisper-realtime-bench-'));
const assets = join(work, 'assets');mkdirSync(assets);writeFileSync(join(assets,'index.html'),'Isolated benchmark');
const elapsed = [], received = [], counts = { requests: 0, reads: 0, writes: 0, queryCalls: 0, websocketEvents: 0, heartbeatMessages: 0 };
const pause = ms => new Promise(r => setTimeout(r, ms));
// Per-request test telemetry is returned over the existing internal DO call;
// no extra telemetry service, timer or storage writes are introduced.
const doTelemetry = mode === 'realtime' ? `
import {RealtimeHub as OriginalHub} from ${JSON.stringify(workerPath.replaceAll('\\','/'))};
export class RealtimeHub extends OriginalHub {
 constructor(state,env){
  const metrics={d1Reads:0,sqliteReads:0,sqliteWrites:0};
  const d1=d=>({withSession:x=>d1(d.withSession(x)),prepare:sql=>({bind:(...args)=>({first:async()=>{const r=await d.prepare(sql).bind(...args).all();metrics.d1Reads+=r.meta.rows_read;return r.results[0]??null;}})})});
  const sql={exec:(query,...args)=>{const cursor=state.storage.sql.exec(query,...args);const rows=cursor.toArray();metrics.sqliteReads+=cursor.rowsRead;metrics.sqliteWrites+=cursor.rowsWritten;return {toArray:()=>rows};}};
  const facade=new Proxy(state,{get:(target,key)=>key==='storage'?{sql}:typeof target[key]==='function'?target[key].bind(target):target[key]});
  super(facade,{...env,DB:d1(env.DB)});this.metrics=metrics;
 }
 async fetch(request){
  const before={...this.metrics},response=await super.fetch(request),headers=new Headers(response.headers);
  for(const [key,value] of Object.entries(this.metrics))headers.set('x-test-do-'+key,value-before[key]);
  return new Response(response.body,{status:response.status,headers,...(response.status===101?{webSocket:response.webSocket}:{})});
 }
}` : '';
const source = `import worker from ${JSON.stringify(workerPath.replaceAll('\\','/'))};
export * from ${JSON.stringify(workerPath.replaceAll('\\','/'))};
${doTelemetry}
const total={reads:0,writes:0,calls:0,doRequests:0,doD1Reads:0,doSQLiteReads:0,doSQLiteWrites:0,queries:{}};
export default { ...worker, async fetch(request, env, ctx) {
 if(new URL(request.url).pathname==='/api/__benchmark_metrics')return Response.json(total);
 const stats={reads:0,writes:0,calls:0};
 const count=(r,sql)=>{stats.calls++;total.calls++;stats.reads+=r?.meta?.rows_read||0;total.reads+=r?.meta?.rows_read||0;stats.writes+=r?.meta?.rows_written||0;total.writes+=r?.meta?.rows_written||0;const q=total.queries[sql]??={calls:0,reads:0,writes:0};q.calls++;q.reads+=r?.meta?.rows_read||0;q.writes+=r?.meta?.rows_written||0;return r;};
 function db(d){return {withSession:(x)=>db(d.withSession(x)),batch:async(q)=>(await d.batch(q.map(s=>s.raw))).map((r,i)=>count(r,q[i].sql)),prepare:(sql)=>statement(d.prepare(sql),sql)};}
 function statement(q,sql){return {raw:q,sql,bind:(...a)=>statement(q.bind(...a),sql),all:async()=>count(await q.all(),sql),run:async()=>count(await q.run(),sql),first:async(col)=>{const r=count(await q.all(),sql);return col?r.results[0]?.[col]??null:r.results[0]??null;}};}
 const realtime=env.REALTIME?{idFromName:env.REALTIME.idFromName.bind(env.REALTIME),get:id=>({fetch:async request=>{const r=await env.REALTIME.get(id).fetch(request);total.doRequests++;total.doD1Reads+=Number(r.headers.get('x-test-do-d1Reads'))||0;total.doSQLiteReads+=Number(r.headers.get('x-test-do-sqliteReads'))||0;total.doSQLiteWrites+=Number(r.headers.get('x-test-do-sqliteWrites'))||0;return r;}})}:undefined;
 const response=await worker.fetch(request,{...env,DB:db(env.DB),...(realtime?{REALTIME:realtime}:{})},ctx);
 if(response.status===101)return response;
 const out=new Response(response.body,response);out.headers.set('x-test-reads',stats.reads);out.headers.set('x-test-writes',stats.writes);out.headers.set('x-test-query-calls',stats.calls);return out;
}};`;
let mf, a, b;
const measuredFetch = async (...args) => {
  const response = await fetch(...args); counts.requests++;
  counts.reads += Number(response.headers.get('x-test-reads')) || 0;
  counts.writes += Number(response.headers.get('x-test-writes')) || 0;
  counts.queryCalls += Number(response.headers.get('x-test-query-calls')) || 0;
  return response;
};
let metricsURL;
const snapshot = async () => {const all=await (await fetch(metricsURL)).json();return {...counts,reads:all.reads,writes:all.writes,queryCalls:all.calls,doRequests:all.doRequests,doD1Reads:all.doD1Reads,doSQLiteReads:all.doSQLiteReads,doSQLiteWrites:all.doSQLiteWrites};};
const subtract = (after,before) => Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-before[k]]));
const summary = values => {const s=[...values].sort((a,b)=>a-b);return {samples:s.length,medianMs:Math.round(s[Math.floor(s.length*.5)]),p95Ms:Math.round(s[Math.min(s.length-1,Math.ceil(s.length*.95)-1)])};};
try {
  const bundled = await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,platform:'browser',format:'esm',external:['cloudflare:workers']});
  const text=value=>({type:'text',value});
  const env={DB:{type:'d1',id:'benchmark-only'},ASSETS:{type:'assets'},ENVIRONMENT:text('test'),INSTANCE_ID:text('isolated-benchmark'),AUTH_PEPPER:text('b'.repeat(64)),ALLOWED_ORIGINS:text('https://test.whisper.invalid')};
  // The DO binding is added here once the backend class name is established.
  if(mode==='realtime')env.REALTIME={type:'durable-object',worker:'whisper-benchmark',exportName:'RealtimeHub'};
  mf=new Miniflare({port:0,cf:false,logRequests:false,telemetry:{enabled:false},resourcePersistencePath:work,workers:[{config:{name:'whisper-benchmark',compatibilityDate:'2026-09-24',...(mode==='realtime'?{exports:{RealtimeHub:{type:'durable-object',storage:'sqlite'}}}:{}),triggers:[{type:'fetch',pattern:'*/*'}],manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:bundled.outputFiles[0].text}}},env,assets:{directory:assets,runWorkerFirst:['/api/*']}}}]});
  const url=String(await mf.ready).replace(/\/$/,''), db=await mf.getD1Database('DB');
  metricsURL=url+'/api/__benchmark_metrics';
  const { readdirSync }=await import('node:fs');
  const migrations=readdirSync('cloud/migrations').filter(x=>x.endsWith('.sql') && (mode!=='baseline'||x<'0005')).sort();
  const statements=[];let current='';
  for(const line of migrations.map(n=>readFileSync('cloud/migrations/'+n,'utf8')).join('\n').split('\n')) {
    const clean=line.replace(/--.*$/,'').trim();if(!clean)continue;current+=' '+clean;
    if(clean.endsWith(';')&&(!/^CREATE TRIGGER/i.test(current.trim())||/END;$/.test(clean))){statements.push(current.trim());current='';}
  }
  if(current.trim())throw Error('Incomplete migration');
  await db.batch(statements.map(s=>db.prepare(s)));
  a=new WhisperClient({server:url,fetchImpl:measuredFetch});b=new WhisperClient({server:url,fetchImpl:measuredFetch});
  for(const [c,username] of [[a,'benchmark_alice'],[b,'benchmark_bobby']]){
    await c.authenticate({username,password:'BenchOnly9!',register:true});
    await db.prepare("UPDATE users SET status='active' WHERE username=?").bind(username).run();
    await c.authenticate({username,password:'BenchOnly9!'});
  }
  await a.chat('benchmark_bobby');await b.chat('benchmark_alice');
  // Same 200 encrypted retained messages in each edition; no test plaintext is saved.
  for(let i=0;i<200;i++){
    const e=encryptMessage(a.user,a.selected.peer,a.selected.id,'isolated benchmark seed');
    await db.prepare('INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(e.id,a.selected.id,a.user.id,e.type,e.nonce,e.ciphertext,Date.now(),e.expiresAt).run();
  }
  await a.sync();await b.sync();
  let polling, controller;
  if(mode==='baseline')polling=setInterval(()=>void b.sync().catch(()=>{}),2000);
  else {
    const {RealtimeConnection}=await import('../src/realtime-client.mjs');
    class MeterSocket extends WebSocket {send(value){if(value==='ping')counts.heartbeatMessages++;return super.send(value);}}
    controller=new RealtimeConnection({request:b.request.bind(b),url:url.replace(/^http/,'ws')+'/api/realtime',WebSocketImpl:MeterSocket,onChange:async()=>{counts.websocketEvents++;await b.sync();}});controller.start();
  }
  await pause(1200);
  const idleStart=await snapshot();await pause(duration);const idle=subtract(await snapshot(),idleStart);
  const queriesBefore=(await (await fetch(metricsURL)).json()).queries;
  const chatStart=await snapshot(),chatStarted=performance.now(),deliveries=[];
  for(let i=0;i<samples;i++){
    // The same fixed 60-second schedule in both editions, independent of
    // receiver speed. Offsets exercise phases of the old two-second poll.
    await pause(Math.max(0,chatStarted+i*(diagnostic?200:2000)+(i*137)%1000+30-performance.now()));
    const started=performance.now();const id=await a.send('isolated message '+i);const ack=performance.now();elapsed.push(ack-started);
    deliveries.push((async()=>{
      const limit=Date.now()+10000;
      while(!b.messages.some(m=>m.id===id)) {if(Date.now()>limit)throw Error('Receive timeout');await pause(5);}
      if(!b.viewMessages().some(m=>m.id===id&&m.text==='isolated message '+i))throw Error('Decryption mismatch');
      received.push(performance.now()-started);
    })());
  }
  await Promise.all(deliveries);
  await pause(Math.max(0,chatStarted+duration-performance.now()));
  clearInterval(polling);controller?.stop();
  const chat=subtract(await snapshot(),chatStart);
  const queriesAfter=(await (await fetch(metricsURL)).json()).queries;
  const queries=Object.entries(queriesAfter).map(([sql,stats])=>({sql,...subtract(stats,queriesBefore[sql]??{calls:0,reads:0,writes:0})})).filter(q=>q.calls).sort((a,b)=>b.reads-a.reads);
  const report={mode,environment:'local workerd/D1 on Windows; not production-network measurements',seedMessages:200,idleSeconds:duration/1000,chatSeconds:Math.round((performance.now()-chatStarted)/1000),sendToAck:summary(elapsed),sendToVisibleClientModel:summary(received),idle,chat,d1Scope:'Worker request and post-commit D1 meta.rows_read/rows_written; add doD1Reads for total D1 reads. DO SQLite cursor rows and RPC counts are instrumented locally; not billed cloud CPU/GB-s.',generatedAt:new Date().toISOString()};
  mkdirSync('test-results',{recursive:true});writeFileSync('test-results/realtime-'+mode+(diagnostic?'-diagnostic':'')+'.json',JSON.stringify({...report,queries},null,2));console.log(JSON.stringify(report,null,2));
} finally {await a?.logout().catch(()=>{});await b?.logout().catch(()=>{});await mf?.dispose();rmSync(work,{recursive:true,force:true,maxRetries:6,retryDelay:300});}
