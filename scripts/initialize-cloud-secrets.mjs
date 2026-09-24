// One-time setup for the owner's already-authorized Whisper Worker.
// A new server pepper is sent directly to Wrangler stdin: never written to disk,
// terminal output, command-line arguments, Git, or browser assets.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const cli=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const config=resolve(root,'wrangler.jsonc');
const settings=JSON.parse(readFileSync(config,'utf8'));
if(settings.name!=='whisper')throw Error('Refusing a different Worker.');
const existing=JSON.parse(execFileSync(process.execPath,[cli,'secret','list','--config',config],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
if(existing.some(s=>['AUTH_PEPPER','INVITE_CODE'].includes(s.name)))throw Error('Cloud secrets already exist. No values were changed; review setup manually.');
const invitePath=resolve(root,'data/cloud-invite-code.txt');
if(existsSync(invitePath))throw Error('Existing cloud invitation file found; refusing to overwrite.');
const pepper=randomBytes(32),invite='WHC-'+randomBytes(16).toString('hex');
try {
  execFileSync(process.execPath,[cli,'secret','bulk','--name','whisper','--config',config],{
    cwd:root,input:JSON.stringify({AUTH_PEPPER:pepper.toString('hex'),INVITE_CODE:invite}),
    stdio:['pipe','pipe','pipe'],timeout:120000
  });
  mkdirSync(resolve(root,'data'),{recursive:true});
  writeFileSync(invitePath,invite+'\n',{mode:0o600,flag:'wx'});
  console.log('Whisper runtime secrets initialized through Wrangler. Values were not printed.');
  console.log('The cloud invitation code is in ignored data/cloud-invite-code.txt.');
} catch { throw Error('Secret setup did not complete cleanly. Check Wrangler secret names before retrying; do not overwrite an existing pepper.'); }
finally { pepper.fill(0); }
