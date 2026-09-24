import { Miniflare } from 'miniflare';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
export async function cloudFixture() {
  const dir=mkdtempSync(join(tmpdir(),'whisper-cloud-test-'));
  const text=value=>({type:'text',value});
  const mf=new Miniflare({port:0,cf:false,logRequests:false,telemetry:{enabled:false},resourcePersistencePath:dir,
    workers:[{config:{name:'whisper-test',compatibilityDate:'2026-09-24',triggers:[{type:'fetch',pattern:'*/*'}],
      manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:readFileSync('.cloud/worker.mjs','utf8')}}},
      env:{DB:{type:'d1',id:'test-only-db'},ASSETS:{type:'assets'},ENVIRONMENT:text('test'),
        INSTANCE_ID:text('isolated-cloud-test'),AUTH_PEPPER:text('a'.repeat(64)),INVITE_CODE:text('TEST-CLOUD-INVITE'),
        ALLOWED_ORIGINS:text('https://test.whisper.invalid')},
      assets:{directory:resolve('.cloud/public'),runWorkerFirst:['/api/*','/downloads/whisper-cli-windows-x64.zip']}
    }}]});
  try {
    const url=String(await mf.ready).replace(/\/$/,'');
    const db=await mf.getD1Database('DB');
    // D1 exec is line-oriented; prepared batch accepts the complete SQL migration.
    const sql=readFileSync('cloud/migrations/0001_initial.sql','utf8');
    const statements=[];let current='';for(const line of sql.split('\n')){const clean=line.replace(/--.*$/,'').trim();if(!clean)continue;current+=' '+clean;if(clean.endsWith(';')&&(!/^CREATE TRIGGER/i.test(current.trim())||/END;$/.test(clean))){statements.push(current.trim());current='';}} if(current.trim())throw Error('Incomplete test migration');await db.batch(statements.map(s=>db.prepare(s)));
    return {mf,db,url,invite:'TEST-CLOUD-INVITE',async close(){await mf.dispose();rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:300});}};
  }catch(error){await mf.dispose();rmSync(dir,{recursive:true,force:true});throw error;}
}
