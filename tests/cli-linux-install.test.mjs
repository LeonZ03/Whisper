import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const digest = data => createHash('sha256').update(data).digest('hex');
const run = (cmd,args,options={}) => new Promise((resolve,reject)=>{
  const child=spawn(cmd,args,{...options,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
  child.on('close',status=>resolve({status,stdout,stderr}));child.stdin.end(options.input||'');
});
test('Linux real installer: install, upgrade, reinstall, corruption rejection and uninstall preserve private data', {skip:process.platform!=='linux',timeout:180000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'whisper-linux-install-test-'));
  const installer=readFileSync('client-distribution/install.sh');
  const release=JSON.parse(readFileSync('public/downloads/manifest-linux-x64.json'));
  const archive=readFileSync('public/downloads/'+release.filename);
  assert.equal(digest(archive),release.sha256);assert.equal(digest(installer),release.installerSha256);
  const home=join(dir,'home'),install=join(home,'custom install'),bin=join(home,'custom bin');mkdirSync(home);
  const env={...process.env,HOME:home,PATH:'/usr/bin:/bin',DBUS_SESSION_BUS_ADDRESS:'unix:path='+join(dir,'no-bus')};
  delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const script=join(dir,'install.sh');writeFileSync(script,installer);
  // A previous-version fixture uses exactly the bundled runtime and client files;
  // only public release labels/inventory are changed, never user identities.
  const stage=join(dir,'old');mkdirSync(stage);execFileSync('tar',['-xzf',resolve('public/downloads/'+release.filename),'-C',stage]);
  const oldRoot=join(stage,'Whisper-CLI');
  for(const name of ['package.json','BUILD-INFO.json']){const p=JSON.parse(readFileSync(join(oldRoot,name)));p.version='0.5.9';writeFileSync(join(oldRoot,name),JSON.stringify(p,null,2));}
  const inventory=JSON.parse(readFileSync(join(oldRoot,'FILES-SHA256.json')));
  for(const n of Object.keys(inventory))inventory[n]=digest(readFileSync(join(oldRoot,n)));
  writeFileSync(join(oldRoot,'FILES-SHA256.json'),JSON.stringify(inventory,null,2));
  const oldPath=join(dir,'old.tar.gz');execFileSync('tar',['-czf',oldPath,'-C',stage,'Whisper-CLI']);
  let servingArchive=readFileSync(oldPath),servingManifest={...release,version:'0.5.9',bytes:servingArchive.length,sha256:digest(servingArchive)};
  const server=createServer((req,res)=>{if(req.url==='/downloads/manifest-linux-x64.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(servingManifest,null,2));}else if(req.url==='/downloads/'+release.filename){res.setHeader('Content-Length',servingArchive.length);res.end(servingArchive);}else{res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  const installArgs=[script,'--server',url,'--install-dir',install,'--bin-dir',bin,'--no-path'];
  try {
    const first=await run('/bin/bash',installArgs,{env});assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/Installation successful!.*0\.5\.9/);
    assert.equal(existsSync(join(home,'.profile')),false);
    writeFileSync(join(install,'data','public-key-pins.json'),'synthetic-pins');writeFileSync(join(install,'data','login.keyring'),'synthetic-ciphertext');
    servingManifest=release;servingArchive=archive;
    const upgrade=await run('/bin/bash',installArgs,{env});assert.equal(upgrade.status,0,upgrade.stderr);assert.match(upgrade.stdout,/Upgrade successful!.*0\.5\.9 -> v0\.6\.0/);
    const reinstall=await run('/bin/bash',installArgs,{env});assert.equal(reinstall.status,0,reinstall.stderr);assert.match(reinstall.stdout,/Reinstallation successful!/);
    assert.equal(readFileSync(join(install,'data','public-key-pins.json'),'utf8'),'synthetic-pins');assert.equal(readFileSync(join(install,'data','login.keyring'),'utf8'),'synthetic-ciphertext');
    const help=await run(join(bin,'whisper'),['--help'],{env});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/Whisper CLI/);
    // Existing activation must remain usable if the offered archive is tampered.
    servingArchive=Buffer.from(archive);servingArchive[0]^=1;
    const bad=await run('/bin/bash',installArgs,{env});assert.notEqual(bad.status,0);assert.match(bad.stderr,/verification failed/);assert.doesNotMatch(bad.stdout,/successful!/);
    assert.equal((await run(join(bin,'whisper'),['--help'],{env})).status,0);
    const removed=await run(join(bin,'whisper'),['--uninstall'],{env,input:'yes\n'});assert.equal(removed.status,0,removed.stderr);
    assert.equal(existsSync(join(install,'versions')),false);assert.equal(existsSync(join(bin,'whisper')),false);
    assert.equal(readFileSync(join(install,'data','public-key-pins.json'),'utf8'),'synthetic-pins');assert.equal(readFileSync(join(install,'data','login.keyring'),'utf8'),'synthetic-ciphertext');
    assert.equal(existsSync(join(home,'.profile')),false);
  } finally {await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
