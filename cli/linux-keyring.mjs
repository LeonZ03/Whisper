import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const unavailable = () => Object.assign(Error('Linux 系统密钥环不可用。'), { code: 'LOGIN_PROTECTION_UNAVAILABLE' });

// Only public selectors go in argv. Key material travels through private pipes.
// A missing/locked Secret Service never falls back to a key stored beside data.
export function runSecretTool(args, input, executable = '/usr/bin/secret-tool') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000); timer.unref();
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 8192) child.kill(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(unavailable()); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || size > 8192 || ![0, 1].includes(code)) {
        for (const chunk of chunks) chunk.fill(0);
        reject(unavailable()); return;
      }
      const output = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
      resolveRun({ code, output });
    });
    child.stdin.end(input);
  });
}
const hash = value => createHash('sha256').update(value).digest('hex');
function envelope(bytes) {
  const value = JSON.parse(bytes.toString());
  if (value.v !== 1 || !/^[a-f0-9-]{36}$/.test(value.keyId) ||
      !/^[A-Za-z0-9+/]{16}$/.test(value.nonce) || !/^[A-Za-z0-9+/]{22}==$/.test(value.tag) ||
      typeof value.ciphertext !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.ciphertext)) throw Error('保存的登录不可读取。');
  return value;
}
export class LinuxKeyring {
  constructor(directory, run = runSecretTool) { this.scope = hash(resolve(directory)); this.run = run; }
  attributes(origin, keyId) { return ['application', 'org.leonz.whisper.cli', 'storage', this.scope, 'origin', hash(origin), 'key-id', keyId]; }
  async storeKey(origin, keyId, key) {
    const bytes = Buffer.from(key.toString('base64'));
    try {
      const result = await this.run(['store', '--label=Whisper CLI protected login', ...this.attributes(origin, keyId)], bytes);
      result.output.fill(0); if (result.code !== 0) throw unavailable();
    } finally { bytes.fill(0); }
  }
  async loadKey(origin, keyId) {
    const result = await this.run(['lookup', ...this.attributes(origin, keyId)]);
    try {
      const text = result.output.toString().trim();
      if (result.code !== 0 || !/^[A-Za-z0-9+/]{43}=$/.test(text)) throw unavailable();
      return Buffer.from(text, 'base64');
    } finally { result.output.fill(0); }
  }
  async removeKey(origin, keyId) {
    const result = await this.run(['clear', ...this.attributes(origin, keyId)]);
    result.output.fill(0); if (result.code !== 0) throw unavailable();
  }
  async available() {
    const keyId = randomUUID(), key = randomBytes(32), origin = 'storage-probe';
    try {
      await this.storeKey(origin, keyId, key);
      const restored = await this.loadKey(origin, keyId);
      try { return restored.equals(key); } finally { restored.fill(0); }
    } catch { return false; }
    finally { key.fill(0); await this.removeKey(origin, keyId).catch(() => {}); }
  }
  async seal(bytes, origin) {
    const keyId = randomUUID(), key = randomBytes(32), nonce = randomBytes(12);
    try {
      await this.storeKey(origin, keyId, key);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from('whisper-cli-login-v1:' + origin));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.from(JSON.stringify({ v: 1, keyId, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    } catch (error) { await this.removeKey(origin, keyId).catch(() => {}); throw error; }
    finally { key.fill(0); }
  }
  async open(bytes, origin) {
    const value = envelope(bytes), key = await this.loadKey(origin, value.keyId);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
      decipher.setAAD(Buffer.from('whisper-cli-login-v1:' + origin));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
    } catch { throw Error('保存的登录不可读取。'); }
    finally { key.fill(0); }
  }
  async forget(bytes, origin) { await this.removeKey(origin, envelope(bytes).keyId); }
}
