import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWhisperServer } from '../server/app.mjs';
import { prepareEnrollment } from '../src/account-client.mjs';

test('Web reload/new tab resumes sealed login; logout, tampering and revocation require login', async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-web-login-'));
  const app = await createWhisperServer({ port: 0, dataDir: dir });
  const context = await browser.newContext(), page = await context.newPage();
  const failures = []; page.on('pageerror', e => failures.push(e.message));
  const username = 'web_restore', password = 'Synthetic9!';
  const request = await context.request.post(app.localUrl + '/api/auth/register', { headers: { Origin: app.localUrl, 'X-Whisper-Request': '1' }, data: { username, ...await prepareEnrollment(password) } });
  expect(request.status()).toBe(202); app.db.prepare("UPDATE users SET status='active' WHERE username=?").run(username);
  const login = async () => { await expect(page.locator('#auth-screen')).toBeVisible(); await page.locator('#username').fill(username); await page.locator('#password').fill(password); await page.locator('#auth-submit').click(); await expect(page.locator('#self-name')).toHaveText('@' + username); };
  const record = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('whisper-login-v1'); open.onerror = reject;
    open.onsuccess = () => { const db = open.result, tx = db.transaction('vault'); const store = tx.objectStore('vault'); let key, identity;
      store.get('key').onsuccess = e => { key = e.target.result; }; store.get('identity').onsuccess = e => { identity = e.target.result; };
      tx.oncomplete = () => { db.close(); resolve({ key: key ? { extractable: key.extractable, name: key.algorithm.name } : null, identity: identity ? { v: identity.v, keys: Object.keys(identity), bytes: identity.ciphertext.byteLength } : null }); };
    };
  }));
  try {
    await page.goto(app.localUrl); await expect(page.locator('#auth-screen')).toBeVisible();
    // Simulate a page leaving exactly while its newly authenticated identity is
    // being sealed. Normal page exit must preserve that seal, not strand it.
    await page.evaluate(() => {
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt = (...args) => args[0]?.name === 'AES-GCM' ? new Promise((resolve, reject) => {
        window.releaseLoginSeal = () => encrypt(...args).then(resolve, reject);
      }) : encrypt(...args);
    });
    await page.locator('#username').fill(username); await page.locator('#password').fill(password); await page.locator('#auth-submit').click();
    await expect.poll(() => page.evaluate(() => typeof window.releaseLoginSeal)).toBe('function');
    await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide')); window.releaseLoginSeal(); });
    await expect.poll(async () => (await record()).identity).not.toBe(null);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#self-name')).toHaveText('@' + username);
    // A reload removes the test gate and runs normal application startup.
    await page.reload(); await expect(page.locator('#self-name')).toHaveText('@' + username);
    expect(await record()).toMatchObject({ key: { extractable: false, name: 'AES-GCM' }, identity: { v: 1, keys: ['v', 'iv', 'ciphertext'] } });
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(password);
    expect((await context.cookies()).find(c => c.name === 'whisper_session')?.httpOnly).toBe(true);
    await page.reload(); await expect(page.locator('#self-name')).toHaveText('@' + username); await expect(page.locator('#auth-screen')).toBeHidden();
    const second = await context.newPage(); await second.goto(app.localUrl); await expect(second.locator('#self-name')).toHaveText('@' + username);
    expect(app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(1);
    expect(app.db.prepare('SELECT COUNT(*) n FROM login_history').get().n).toBe(1);
    await page.locator('#nav-my').click(); await page.locator('#logout').click();
    await expect(second.locator('#auth-screen')).toBeVisible(); await expect.poll(async () => (await record()).identity).toBe(null);
    await second.close(); await page.reload(); await login();
    // Network loss keeps the sealed record, displays a retry, and never unlocks chat.
    await page.route('**/api/account/me', route => route.abort()); await page.reload();
    await expect(page.locator('#retry-login')).toBeVisible(); expect((await record()).identity).not.toBe(null);
    await page.unroute('**/api/account/me'); await page.locator('#retry-login').click(); await expect(page.locator('#self-name')).toHaveText('@' + username);
    app.db.prepare('UPDATE users SET credential_version=credential_version+1 WHERE username=?').run(username);
    await page.reload(); await expect(page.locator('#auth-screen')).toBeVisible(); await expect.poll(async () => (await record()).identity).toBe(null);
    await login();
    await page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('whisper-login-v1'); open.onsuccess = () => { const db = open.result, tx = db.transaction('vault', 'readwrite'), store = tx.objectStore('vault'); store.get('identity').onsuccess = e => { const value = e.target.result; new Uint8Array(value.ciphertext)[0] ^= 1; store.put(value, 'identity'); }; tx.oncomplete = () => { db.close(); resolve(); }; }; }));
    await page.reload(); await expect(page.locator('#auth-screen')).toBeVisible(); await expect.poll(async () => (await record()).identity).toBe(null);
    expect(failures).toEqual([]);
  } finally { await context.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
