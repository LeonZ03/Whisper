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
for(const name of ['index.html','style.css','favicon.svg','cli.html','cli-install.css','cli-install.mjs','cli-command.mjs']) {
  writeFileSync(join(assets,name),readFileSync(join(root,'public',name)));
}
await build({absWorkingDir:root,entryPoints:['src/app.mjs'],outfile:join(assets,'app.js'),bundle:true,minify:true,
  platform:'browser',format:'esm',target:['es2022'],sourcemap:false,legalComments:'eof'});
const html=readFileSync(join(assets,'index.html'),'utf8').replace('class="edition">LOCAL','class="edition">CLOUD');
writeFileSync(join(assets,'index.html'),html);
writeFileSync(join(assets,'_headers'),'/*\n'+Object.entries({...SECURITY_HEADERS,'Strict-Transport-Security':'max-age=31536000'}).map(([k,v])=>'  '+k+': '+v).join('\n')+'\n');
const files={},dependencies=new Map(),add=(name,value)=>{files[name]=value instanceof Uint8Array?value:strToU8(value);};
function copy(source,target) {
  if(lstatSync(source).isSymbolicLink())throw Error('Symlink in release input');
  if(lstatSync(source).isDirectory())for(const n of readdirSync(source).sort())copy(join(source,n),target+'/'+n);
  else add(target,readFileSync(source));
}
function dependency(name) {
  if(dependencies.has(name))return;
  const p=join(root,'node_modules',name),data=JSON.parse(readFileSync(join(p,'package.json')));
  dependencies.set(name,data.version);copy(p,'node_modules/'+name);
  for(const child of Object.keys(data.dependencies||{}))dependency(child);
}
for(const n of ['application.mjs','client.mjs','index.mjs','terminal.mjs','theme.mjs','transcript.mjs'])copy(join(root,'cli',n),'cli/'+n);
copy(join(root,'src/crypto.mjs'),'src/crypto.mjs');
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
await build({absWorkingDir:root,entryPoints:['cloud/worker.mjs'],outfile:join(out,'worker.mjs'),bundle:true,
  platform:'browser',format:'esm',target:['es2022'],sourcemap:false,
  define:{__APP_VERSION__:JSON.stringify(pkg.version),__COMMIT__:JSON.stringify(commit)}});
console.log(JSON.stringify({cloudBuild:true,version:pkg.version,commit,assets:' .cloud/public',cliBytes:manifest.bytes,chunks:chunks.length,cliSHA256:manifest.sha256}));
