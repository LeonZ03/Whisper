// One-time setup for the owner's already-authorized Whisper Worker.
// A new server pepper is sent directly to Wrangler stdin: never written to disk,
// terminal output, command-line arguments, Git, or browser assets.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const cli=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const config=resolve(root,'wrangler.jsonc');
const settings=JSON.parse(readFileSync(config,'utf8'));
if(settings.name!=='whisper')throw Error('Refusing a different Worker.');
const existing=JSON.parse(execFileSync(process.execPath,[cli,'secret','list','--config',config],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
if(existing.some(s=>s.name==='AUTH_PEPPER'))throw Error('AUTH_PEPPER already exists. No values were changed; never rotate it to initialize accounts.');
const pepper=randomBytes(32);
try {
  execFileSync(process.execPath,[cli,'secret','bulk','--name','whisper','--config',config],{
    cwd:root,input:JSON.stringify({AUTH_PEPPER:pepper.toString('hex')}),
    stdio:['pipe','pipe','pipe'],timeout:120000
  });
  console.log('Whisper AUTH_PEPPER initialized through Wrangler. Its value was not printed.');
} catch { throw Error('Secret setup did not complete cleanly. Check Wrangler secret names before retrying; do not overwrite an existing pepper.'); }
finally { pepper.fill(0); }
