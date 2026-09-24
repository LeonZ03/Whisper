import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TerminalUI } from '../cli/terminal.mjs';
import { prepareOwnerMaterial } from '../accounts/owner-material.mjs';
import { digest } from '../cloud/security.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const ownerDataDir = resolve(process.env.WHISPER_DATA_DIR || resolve(root, 'data'));
const args = process.argv.slice(2), cloud = args.includes('--cloud'), recover = args.includes('--recover');
if (args.some(a => !['--cloud','--local','--recover'].includes(a)) || cloud === args.includes('--local')) throw Error('Use --cloud or --local; optional --recover. Passwords are never command-line arguments.');
if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Owner setup requires an interactive terminal. Do not use redirection or run it in CI.');
const ui = new TerminalUI(); let local, access = '', material, activationFile;
try {
  ui.start(); ui.set({ header: ['Whisper · 网站管理员初始化 / 恢复'], body: [cloud ? '目标：正式云端 Whisper 数据库' : '目标：本机 Whisper 数据库', '', '只管理网站 root，不修改操作系统用户。', '不会读取成员密码、解密成员聊天或重建数据库。', '首次密码由你隐藏输入；还会生成一次激活码，首次登录后必须改密。', '恢复 root 会撤销原 root 会话；不改变其他成员的密钥。'], hint: 'Enter 确认 · Esc 取消 · Ctrl+C 退出' });
  ui.on('quit', () => { ui.cancelQuestion(); });
  const targetPhrase = cloud ? 'Whisper cloud root' : 'Whisper local root';
  const confirmation = await ui.ask(`确认目标环境，请输入 ${targetPhrase}`);
  if (confirmation !== targetPhrase) throw Error('Cancelled');
  const query = cloud ? await cloudQuery() : localQuery();
  const previous = (await query("SELECT * FROM users WHERE username='root'", []))[0];
  if (previous && previous.role !== 'root') throw Error('Reserved username is occupied; refusing to promote another account.');
  if (previous && !recover) throw Error('Root already exists. Use --recover only after reviewing its effects.');
  if (!previous && recover) throw Error('Root does not exist. Use initialization without --recover.');
  let password = await ui.ask(recover ? '设置 root 临时密码（1–12 字符）' : '输入规定的首次密码 0000', { secret: true });
  let repeat = await ui.ask('再次输入', { secret: true });
  if (password !== repeat) throw Error('Passwords differ');
  if (!recover && password !== '0000') throw Error('First initialization requires the specified 0000 password.');
  material = await prepareOwnerMaterial(password); password = ''; repeat = '';
  const r = material.row;
  // Persist the one-time code before changing the database. A failed write
  // cannot leave an activated root whose activation secret has been lost.
  mkdirSync(ownerDataDir, { recursive: true });
  activationFile = resolve(ownerDataDir, `${cloud ? 'cloud' : 'local'}-root-activation-${randomUUID()}.txt`);
  writeFileSync(activationFile, material.activationCode + '\n', { mode: 0o600, flag: 'wx' });
  if (!previous) {
    await query("INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,auth_scheme,created_at,role,status,must_change) VALUES(?,'root',?,?,?,?,?,?,'root-bootstrap-hmac-v1',?,'root','active',1)", [r.id,r.publicKey,r.salt,r.vault.nonce,r.vault.ciphertext,r.authSalt,r.authHash,Date.now()]);
  } else {
    const changed = await query("UPDATE users SET public_key=?,salt=?,vault_nonce=?,vault_cipher=?,auth_salt=?,auth_hash=?,auth_scheme='root-bootstrap-hmac-v1',status='active',must_change=1,root_activation_consumed=0,credential_version=credential_version+1 WHERE id=? AND role='root' AND credential_version=? RETURNING id", [r.publicKey,r.salt,r.vault.nonce,r.vault.ciphertext,r.authSalt,r.authHash,previous.id,previous.credential_version]);
    if (!changed.length) throw Error('Account changed concurrently. Recheck before retrying.');
  }
  await query('UPDATE auth_failures SET failures=0,until_at=0 WHERE scope=?', [await digest('account-login:root')]);
  await query('INSERT INTO admin_audit(timestamp,action,target_id,target_name) VALUES(?,?,?,?)', [Date.now(),recover?'owner_recovery':'owner_initialization',previous?.id||r.id,'root']);
  ui.stop(); console.log('Whisper root is prepared. The password was not printed or stored as plaintext.');
  console.log('Private first-login activation code: ' + activationFile);
  console.log('Open the website, sign in as root, supply this activation code, then change the initial password.');
} catch (error) { ui.stop(); console.error('Setup stopped: ' + String(error.message).replace(/[\x00-\x1f]/g,' ').slice(0,160)); if (activationFile) console.error('Check root state before retrying; prepared activation file: ' + activationFile); process.exitCode = 1; }
finally { access = ''; material = null; local?.close(); ui.stop(); }
function localQuery() {
  if (existsSync(resolve(ownerDataDir,'runtime.json'))) throw Error('Stop the local Whisper service before owner maintenance.');
  if (!existsSync(resolve(ownerDataDir,'whisper.sqlite'))) throw Error('Local database does not exist. Initialize the local instance before owner maintenance.');
  local = new DatabaseSync(resolve(ownerDataDir,'whisper.sqlite'));
  local.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  return async (sql, params) => /RETURNING|^SELECT/i.test(sql) ? local.prepare(sql).all(...params) : (local.prepare(sql).run(...params), []);
}
async function cloudQuery() {
  const cfg = JSON.parse(readFileSync(resolve(root,'wrangler.jsonc'),'utf8'));
  if (cfg.name !== 'whisper' || cfg.d1_databases?.[0]?.database_name !== 'whisper-production') throw Error('Expected Whisper production Worker and D1 database configuration.');
  const result = execFileSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'auth','token','--json'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  access = JSON.parse(result).token; if (!access) throw Error('Run wrangler login first.');
  return async (sql, params) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.account_id}/d1/database/${cfg.d1_databases[0].database_id}/query`,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(30000)});
    const data = await response.json(); if (!response.ok || !data.success) throw Error('Owner database request failed; no credential values are displayed.'); return data.result[0]?.results || [];
  };
}
