import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { SECURITY_HEADERS } from '../cloud/security.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'.cloud'),assets=join(out,'public');
const sha=b=>createHash('sha256').update(b).digest('hex');
const pkg=JSON.parse(readFileSync(join(root,'package.json')));
let commit=process.env.WORKERS_CI_COMMIT_SHA||process.env.GITHUB_SHA;
if(!commit)try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{commit='local';}
rmSync(out,{recursive:true,force:true});mkdirSync(assets,{recursive:true});
for(const name of ['index.html','style.css','brand-mark.svg','favicon.svg','cli.html','cli-install.css','cli-install.mjs','cli-command.mjs']) {
  writeFileSync(join(assets,name),readFileSync(join(root,'public',name)));
}
await build({absWorkingDir:root,entryPoints:['src/app.mjs'],outfile:join(assets,'app.js'),bundle:true,minify:true,
  platform:'browser',format:'esm',target:['es2022'],sourcemap:false,legalComments:'eof',
  define:{__APP_VERSION__:JSON.stringify(pkg.version)}});
const html=readFileSync(join(assets,'index.html'),'utf8').replace('class="edition">LOCAL','class="edition">CLOUD');
writeFileSync(join(assets,'index.html'),html);
writeFileSync(join(assets,'_headers'),'/*\n'+Object.entries({...SECURITY_HEADERS,'Strict-Transport-Security':'max-age=31536000'}).map(([k,v])=>'  '+k+': '+v).join('\n')+'\n');
const files={},dependencies=new Map(),add=(name,value,destination=files)=>{destination[name]=value instanceof Uint8Array?value:strToU8(value);};
function copy(source,target,destination=files) {
  if(lstatSync(source).isSymbolicLink())throw Error('Symlink in release input');
  if(lstatSync(source).isDirectory())for(const n of readdirSync(source).sort())copy(join(source,n),target+'/'+n,destination);
  else add(target,readFileSync(source),destination);
}
function dependency(name,destination=files,seen=dependencies) {
  if(seen.has(name))return;
  const p=join(root,'node_modules',name),data=JSON.parse(readFileSync(join(p,'package.json')));
  seen.set(name,data.version);copy(p,'node_modules/'+name,destination);
  for(const child of Object.keys(data.dependencies||{}))dependency(child,destination,seen);
}
for(const n of ['application.mjs','client.mjs','index.mjs','terminal.mjs','theme.mjs','transcript.mjs', 'account-ui.mjs', 'login-store.mjs', 'linux-keyring.mjs'])copy(join(root,'cli',n),'cli/'+n);
copy(join(root,'src/crypto.mjs'),'src/crypto.mjs');
copy(join(root,'src/account-client.mjs'),'src/account-client.mjs');
copy(join(root,'src/realtime-client.mjs'),'src/realtime-client.mjs');
for(const n of ['whisper.cmd','README.txt','uninstall.ps1'])copy(join(root,'client-distribution',n),n);
copy(join(root,'client-distribution/remote-entry.mjs'),'cli/remote-entry.mjs');
dependency('libsodium-wrappers');dependency('string-width');
const runtime=JSON.parse(readFileSync(join(root,'cloud/node-runtime.json'))),cache=join(root,'.runtime',runtime.filename);
let zip=existsSync(cache)?readFileSync(cache):null;
if(!zip||sha(zip)!==runtime.sha256) {
  const response=await fetch(runtime.url,{redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw Error('Official runtime download failed: '+response.status);
  zip=new Uint8Array(await response.arrayBuffer());
  if(sha(zip)!==runtime.sha256)throw Error('Official runtime SHA-256 mismatch');
  mkdirSync(dirname(cache),{recursive:true});writeFileSync(cache,zip);
}
const prefix=runtime.filename.replace(/\.zip$/,'')+'/';
const runtimeFiles=unzipSync(zip,{filter:f=>[prefix+'node.exe',prefix+'LICENSE'].includes(f.name)});
if(!runtimeFiles[prefix+'node.exe']||!runtimeFiles[prefix+'LICENSE'])throw Error('Runtime archive incomplete');
add('runtime/node.exe',runtimeFiles[prefix+'node.exe']);add('runtime/LICENSE',runtimeFiles[prefix+'LICENSE']);
add('package.json',JSON.stringify({name:'whisper-cli-portable',private:true,type:'module',version:pkg.version},null,2));
add('BUILD-INFO.json',JSON.stringify({version:pkg.version,node:runtime.version,platform:'win32-x64',runtimeSHA256:sha(files['runtime/node.exe']),dependencies:Object.fromEntries(dependencies)},null,2));
add('FILES-SHA256.json',JSON.stringify(Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha(b)])),null,2));
const releaseZIP=zipSync(Object.fromEntries(Object.entries(files).map(([n,b])=>['Whisper-CLI/'+n,[b,{mtime:new Date('2020-01-01T00:00:00Z'),level:6}]])));
const chunkDir=join(assets,'downloads/chunks');mkdirSync(chunkDir,{recursive:true});
const chunks=[];for(let i=0;i<releaseZIP.length;i+=8*1024*1024){
  const part=releaseZIP.subarray(i,i+8*1024*1024),name=sha(part)+'.part';
  writeFileSync(join(chunkDir,name),part);chunks.push(name);
}
const installer=readFileSync(join(root,'client-distribution/install.ps1'));
const manifest={version:pkg.version,platform:'windows-x64',node:runtime.version,filename:'whisper-cli-windows-x64.zip',
  bytes:releaseZIP.length,sha256:sha(releaseZIP),installerSha256:sha(installer),fileCount:Object.keys(files).length,chunks};
writeFileSync(join(assets,'install.ps1'),installer);
writeFileSync(join(assets,'downloads/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(join(out,'client.zip'),releaseZIP);

const linuxRuntime=JSON.parse(readFileSync(join(root,'cloud/node-runtime-linux.json'),'utf8'));
const linuxInstaller=readFileSync(join(root,'client-distribution/install.sh'));
writeFileSync(join(assets,'install.sh'),linuxInstaller);
for(const arch of ['x64','arm64']) {
  const platform='linux-'+arch,filename='whisper-cli-'+platform+'.tar.gz';
  const spec=linuxRuntime.runtimes[arch],cache=join(root,'.runtime',spec.filename);
  let runtimeArchive=existsSync(cache)?readFileSync(cache):null;
  if(!runtimeArchive||sha(runtimeArchive)!==spec.sha256) {
    const response=await fetch(spec.url,{redirect:'error',signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw Error('Official Linux runtime download failed: '+response.status);
    runtimeArchive=new Uint8Array(await response.arrayBuffer());
    if(sha(runtimeArchive)!==spec.sha256)throw Error('Official Linux runtime SHA-256 mismatch');
    mkdirSync(dirname(cache),{recursive:true});writeFileSync(cache,runtimeArchive);
  }
  const prefix=spec.filename.replace(/\.tar\.gz$/,'')+'/';
  const node=execFileSync('tar',['-xOzf',cache,prefix+'bin/node'],{maxBuffer:256*1024*1024});
  const license=execFileSync('tar',['-xOzf',cache,prefix+'LICENSE'],{maxBuffer:2*1024*1024});
  if(node.length<1_000_000||!license.toString('utf8').includes('Permission is hereby granted'))throw Error('Official Linux runtime archive incomplete');
  const linuxFiles={},linuxDeps=new Map();
  for(const n of ['application.mjs','client.mjs','index.mjs','terminal.mjs','theme.mjs','transcript.mjs','account-ui.mjs','login-store.mjs','linux-keyring.mjs'])copy(join(root,'cli',n),'cli/'+n,linuxFiles);
  copy(join(root,'src/crypto.mjs'),'src/crypto.mjs',linuxFiles);copy(join(root,'src/account-client.mjs'),'src/account-client.mjs',linuxFiles);
  copy(join(root,'src/realtime-client.mjs'),'src/realtime-client.mjs',linuxFiles);
  copy(join(root,'client-distribution/remote-entry.mjs'),'cli/remote-entry.mjs',linuxFiles);
  copy(join(root,'client-distribution/whisper'),'whisper',linuxFiles);
  copy(join(root,'client-distribution/uninstall-linux.sh'),'uninstall-linux.sh',linuxFiles);
  dependency('libsodium-wrappers',linuxFiles,linuxDeps);dependency('string-width',linuxFiles,linuxDeps);
  add('runtime/node',node,linuxFiles);add('runtime/LICENSE',license,linuxFiles);
  add('package.json',JSON.stringify({name:'whisper-cli-portable',private:true,type:'module',version:pkg.version},null,2),linuxFiles);
  add('BUILD-INFO.json',JSON.stringify({version:pkg.version,node:linuxRuntime.version,platform,glibcMinimum:linuxRuntime.glibcMinimum,kernelMinimum:linuxRuntime.kernelMinimum,runtimeSHA256:sha(node),dependencies:Object.fromEntries(linuxDeps)},null,2),linuxFiles);
  add('FILES-SHA256.json',JSON.stringify(Object.fromEntries(Object.entries(linuxFiles).map(([n,b])=>[n,sha(b)])),null,2),linuxFiles);
  const stage=join(out,'linux-release',arch,'Whisper-CLI');rmSync(dirname(stage),{recursive:true,force:true});mkdirSync(stage,{recursive:true});
  for(const [name,bytes] of Object.entries(linuxFiles)){const path=join(stage,...name.split('/'));mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);}
  const archivePath=join(out,filename);execFileSync('tar',['-czf',archivePath,'-C',dirname(stage),'Whisper-CLI'],{timeout:180000});
  const archive=readFileSync(archivePath),linuxChunks=[];
  for(let i=0;i<archive.length;i+=8*1024*1024){const part=archive.subarray(i,i+8*1024*1024),name=sha(part)+'.part';writeFileSync(join(chunkDir,name),part);linuxChunks.push(name);}
  const linuxManifest={version:pkg.version,platform,node:linuxRuntime.version,glibcMinimum:linuxRuntime.glibcMinimum,kernelMinimum:linuxRuntime.kernelMinimum,filename,bytes:archive.length,sha256:sha(archive),installerSha256:sha(linuxInstaller),fileCount:Object.keys(linuxFiles).length,chunks:linuxChunks};
  writeFileSync(join(assets,'downloads/manifest-'+platform+'.json'),JSON.stringify(linuxManifest,null,2)+'\n');
}
await build({absWorkingDir:root,entryPoints:['cloud/worker.mjs'],outfile:join(out,'worker.mjs'),bundle:true,
  platform:'browser',format:'esm',target:['es2022'],sourcemap:false,
  define:{__APP_VERSION__:JSON.stringify(pkg.version),__COMMIT__:JSON.stringify(commit)}});
console.log(JSON.stringify({cloudBuild:true,version:pkg.version,commit,assets:' .cloud/public',cliBytes:manifest.bytes,chunks:chunks.length,cliSHA256:manifest.sha256,linuxArchives:['x64','arm64']}));
