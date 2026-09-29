import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
if(process.platform!=='linux')throw Error('Run the installed-client PTY check on Linux.');
const work=mkdtempSync(join(tmpdir(),'whisper-linux-package-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=(cmd,args,env)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{env,stdio:'inherit'});p.on('error',reject);p.on('close',status=>status===0?resolve():reject(Error('Isolated Linux verification failed: '+status)));});
const files=new Map();let server;
try {
  for(const arch of ['x64','arm64']){
    const manifest=JSON.parse(readFileSync(`public/downloads/manifest-linux-${arch}.json`));
    const archive=readFileSync('public/downloads/'+manifest.filename);assert.equal(sha(archive),manifest.sha256);
    const node=execFileSync('tar',['-xOzf',resolve('public/downloads/'+manifest.filename),'Whisper-CLI/runtime/node'],{maxBuffer:256*1024*1024});
    assert.equal(node.subarray(0,4).toString('hex'),'7f454c46');assert.equal(node.readUInt16LE(18),arch==='x64'?62:183);
    const inventory=JSON.parse(execFileSync('tar',['-xOzf',resolve('public/downloads/'+manifest.filename),'Whisper-CLI/FILES-SHA256.json'],{maxBuffer:2*1024*1024}));
    assert.equal(sha(node),inventory['runtime/node']);assert.ok(inventory['src/realtime-client.mjs']);
    assert.equal(Object.keys(inventory).some(n=>/^(data|server|cloud|tests)\//.test(n)),false);
    files.set('/downloads/manifest-linux-'+arch+'.json',Buffer.from(JSON.stringify(manifest,null,2)));
    files.set('/downloads/'+manifest.filename,archive);
  }
  server=createServer((req,res)=>{const bytes=files.get(req.url);if(!bytes){res.writeHead(404);res.end();return;}res.setHeader('Content-Length',bytes.length);res.end(bytes);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const home=join(work,'home'),installation=join(work,'installed'),bin=join(work,'bin');mkdirSync(home);
  const env={...process.env,HOME:home,PATH:'/usr/bin:/bin',DBUS_SESSION_BUS_ADDRESS:'unix:path='+join(work,'no-bus')};delete env.NODE_PATH;delete env.NODE_OPTIONS;
  await run('/bin/bash',['client-distribution/install.sh','--server','http://127.0.0.1:'+server.address().port,'--install-dir',installation,'--bin-dir',bin,'--no-path'],env);
  await run(join(installation,'current/runtime/node'),['--test','--test-force-exit','tests/cli-linux-tty.test.mjs'],{...env,WHISPER_TEST_LAUNCHER:join(bin,'whisper')});
  console.log('LINUX_PACKAGE_OK: x64 actual installation and PTY; ARM64 archive hash/ELF only (no ARM64 execution).');
} finally {if(server)await new Promise(r=>server.close(r));rmSync(work,{recursive:true,force:true});}
