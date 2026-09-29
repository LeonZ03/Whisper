import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Fixed helper source only; secrets travel in pipes, never command arguments,
// environment variables, PowerShell history, temporary plaintext files or logs.
function protect(operation, bytes, origin) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd() | ConvertFrom-Json; $b=[Convert]::FromBase64String($p.data); $e=[Text.Encoding]::UTF8.GetBytes($p.origin); try { $o=[Security.Cryptography.ProtectedData]::${operation}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o)) } finally { [Array]::Clear($b,0,$b.Length); if ($o) { [Array]::Clear($o,0,$o.Length) } }`;
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let count = 0;
    const timer = setTimeout(() => child.kill(), 15000); timer.unref();
    child.stdout.on('data', chunk => { count += chunk.length; if (count > 65536) child.kill(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Error('Windows 登录保护不可用。')); });
    child.on('close', code => {
      clearTimeout(timer); const output = Buffer.concat(chunks);
      try {
        if (code !== 0 || !output.length || count > 65536) throw Error('Windows 登录保护不可用。');
        resolve(Buffer.from(output.toString().trim(), 'base64'));
      } catch { reject(Error('Windows 登录保护不可用。')); }
      finally { output.fill(0); for (const chunk of chunks) chunk.fill(0); }
    });
    child.stdin.end(JSON.stringify({ data: bytes.toString('base64'), origin: 'whisper-cli-login-v1:' + origin }));
  });
}
export class ProtectedLoginStore {
  constructor(directory) { this.directory = directory; this.pending = Promise.resolve(); this.epoch = 0; }
  sequence(task) { const result = this.pending.then(task); this.pending = result.catch(() => {}); return result; }
  path(origin) { return join(this.directory, `login-${createHash('sha256').update(origin).digest('hex')}.dpapi`); }
  async available() {
    if (process.platform !== 'win32') return false;
    const probe = Buffer.from('whisper-storage-check');
    try { const sealed = await protect('Protect', probe, 'probe'); const opened = await protect('Unprotect', sealed, 'probe'); const ok = opened.equals(probe); opened.fill(0); return ok; }
    catch { return false; } finally { probe.fill(0); }
  }
  save(origin, identity) {
    const ticket = this.epoch;
    return this.sequence(async () => {
      const bytes = Buffer.from(JSON.stringify({ v: 1, origin, ...identity }));
      const path = this.path(origin), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const sealed = await protect('Protect', bytes, origin);
        if (ticket !== this.epoch) return false;
        await mkdir(this.directory, { recursive: true });
        await writeFile(temporary, sealed, { flag: 'wx', mode: 0o600 });
        if (ticket !== this.epoch) return false;
        await rename(temporary, path); return true;
      } finally { bytes.fill(0); await unlink(temporary).catch(() => {}); }
    });
  }
  load(origin) {
    return this.sequence(async () => {
      let sealed;
      try { sealed = await readFile(this.path(origin)); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('保存的登录不可读取。'); }
      if (sealed.length > 32768 || process.platform !== 'win32') throw Error('保存的登录不可读取。');
      const bytes = await protect('Unprotect', sealed, origin);
      try { const result = JSON.parse(bytes.toString()); if (result.v !== 1 || result.origin !== origin) throw Error(); return result; }
      catch { throw Error('保存的登录不可读取。'); } finally { bytes.fill(0); }
    });
  }
  clear(origin) { this.epoch++; return this.sequence(async () => { try { await unlink(this.path(origin)); } catch (error) { if (error.code !== 'ENOENT') throw Error('保存的登录无法清除。'); } }); }
}
