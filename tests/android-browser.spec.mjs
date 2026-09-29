import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhisperServer } from '../server/app.mjs';
let app, dir;
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'whisper-android-')); app = await createWhisperServer({ dataDir: dir, port: 0 });
  mkdirSync('test-results/android', { recursive: true });
});
test.afterAll(async () => { await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// Exercise the actual APK assets and native request/response contract against an
// isolated real API. The OS window flag is checked separately in the APK build.
async function client(browser) {
  const context = await browser.newContext({ viewport: { width: 393, height: 800 } });
  let cookie = '', requests = [], clears = 0, savedLogin = null, offline = false;
  await context.exposeBinding('androidRequest', async ({ page }, id, path, method, body) => {
    requests.push({ path, method, body });
    if (offline) { await page.evaluate(id => globalThis.whisperAndroidResponse(id, 0, ''), id); return; }
    const response = await fetch(app.localUrl + path, { method, headers: { Origin: app.localUrl, Cookie: cookie,
      'X-Whisper-Client': 'app', 'X-Whisper-Device': 'OPPO test / Android 15',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Whisper-Request': '1' }) }, body: method === 'GET' ? undefined : body });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    let data = await response.text();
    if (path === '/api/health') data = JSON.stringify({ ...JSON.parse(data), environment: 'cloud', pollIntervalMs: 2000 });
    await page.evaluate(({ id, status, data }) => globalThis.whisperAndroidResponse(id, status, data), { id, status: response.status, data });
  });
  await context.exposeBinding('androidClear', () => { cookie = ''; savedLogin = null; clears++; });
  await context.exposeBinding('androidSave', (_, identity) => { savedLogin = { cookie, identity }; return true; });
  await context.exposeBinding('androidRestore', () => { if (!savedLogin) return ''; cookie = savedLogin.cookie; return savedLogin.identity; });
  await context.addInitScript(() => {
    globalThis.WhisperNative = {
      request: (id, path, method, body) => { void globalThis.androidRequest(id, path, method, body); },
      saveLogin: identity => globalThis.androidSave(identity), restoreLogin: () => globalThis.androidRestore(),
      clearSession: () => { void globalThis.androidClear(); }, exit: () => { globalThis.androidExited = true; }
    };
  });
  await context.route('https://appassets.androidplatform.net/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const name = path === '/' ? 'index.html' : path.substring(1);
    if (!['index.html', 'style.css', 'app.js', 'brand-mark.svg'].includes(name)) return route.abort();
    const mime = { 'index.html': 'text/html', 'style.css': 'text/css', 'app.js': 'text/javascript', 'brand-mark.svg': 'image/svg+xml' }[name];
    await route.fulfill({ contentType: mime, body: readFileSync(join('.runtime/android-build/assets', name)), headers: {
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    } });
  });
  const page = await context.newPage(); page.on('dialog', dialog => dialog.accept());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://appassets.androidplatform.net/index.html'); await expect(page.locator('#auth-submit')).toBeEnabled();
  return { context, page, errors, requests, getCookie: () => cookie, clears: () => clears, hasSavedLogin: () => Boolean(savedLogin),
    restart: async () => { cookie = ''; await page.reload(); }, setOffline: value => { offline = value; } };
}

test('Android packaged UI: durable login, devices, encrypted chat, 3-second images and logout', async ({ browser }) => {
  const a = await client(browser), b = await client(browser); const password = 'Android26!';
  async function apply(c, username) {
    await c.page.locator('#register-tab').click(); await c.page.locator('#username').fill(username);
    await c.page.locator('#password').fill(password); await c.page.locator('#auth-submit').click();
    await expect(c.page.locator('#toast')).toContainText('等待管理员审批');
    app.db.prepare("UPDATE users SET status='active', reviewed_at=? WHERE username=? AND status='pending'").run(Date.now(), username);
  }
  async function login(c, username) {
    await c.page.locator('#username').fill(username); await c.page.locator('#password').fill(password);
    await c.page.locator('#auth-submit').click(); await expect(c.page.locator('#chat-screen')).toBeVisible();
  }
  try {
    await expect(a.page.locator('#auth-screen [data-app-version]')).toHaveText(`v${version}`);
    await a.page.screenshot({ path: 'test-results/android/login.png' });
    await apply(a, 'android_alice'); await apply(b, 'android_bobby'); await login(a, 'android_alice'); await login(b, 'android_bobby');
    await expect(a.page.locator('#chat-screen')).toHaveAttribute('data-view', 'conversations');
    await expect(a.page.locator('#nav-my')).toBeVisible();
    await a.page.locator('#nav-my').click(); await expect(a.page.locator('#my-name')).toHaveText('android_alice');
    await expect(a.page.locator('#my-panel [data-app-version]')).toHaveText(`v${version}`);
    await expect(a.page.locator('#account-sessions')).toContainText('OPPO test');
    await expect(a.page.locator('#account-sessions')).toContainText('Android App');
    await expect(a.page.locator('#account-sessions')).toContainText('IP 127.0.0.1');
    expect(await a.page.locator('#privacy-button').evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe('0px');
    await a.page.screenshot({ path: 'test-results/android/my.png' });
    await a.page.locator('#privacy-button').click(); await expect(a.page.locator('#privacy-dialog')).toBeVisible();
    await a.page.evaluate(() => globalThis.whisperAndroidBack()); await expect(a.page.locator('#privacy-dialog')).not.toBeVisible();
    await a.page.locator('#nav-conversations').click(); await a.page.locator('#peer-name').fill('android_bobby');
    await a.page.getByRole('button', { name: '开始会话', exact: true }).click();
    await expect(a.page.locator('#chat-screen')).toHaveAttribute('data-view', 'chat');
    await expect(a.page.locator('#mobile-nav')).not.toBeVisible();
    await b.page.getByRole('button', { name: '与 android_alice 的会话' }).click();
    const text = '安卓端消息 <img src=x onerror=alert(1)>'; await a.page.locator('#message-input').fill(text); await a.page.locator('#send').click();
    await expect(b.page.locator('.bubble').filter({ hasText: text })).toBeVisible({ timeout: 15000 });
    expect(await b.page.locator('.bubble img').count()).toBe(0);
    expect(a.requests.map(r => r.body).join('')).not.toContain(text); expect(a.requests.map(r => r.body).join('')).not.toContain(password);
    expect(readFileSync(join(dir, 'whisper.sqlite')).includes(Buffer.from(text))).toBe(false);
    const loginRequests = a.requests.filter(r => r.path === '/api/auth/login').length;
    const originalCookie = a.getCookie();
    await a.page.evaluate(() => globalThis.whisperAndroidPause());
    await expect(a.page.locator('#chat-screen')).toBeVisible(); await expect(a.page.locator('.bubble')).toHaveCount(0);
    expect(a.getCookie()).toBe(originalCookie); expect(a.hasSavedLogin()).toBe(true);
    await a.page.evaluate(() => globalThis.whisperAndroidResume());
    await expect(a.page.locator('.bubble').filter({ hasText: text })).toBeVisible();
    await a.restart(); await expect(a.page.locator('#chat-screen')).toBeVisible();
    expect(a.requests.filter(r => r.path === '/api/auth/login').length).toBe(loginRequests);
    expect(a.getCookie()).toBe(originalCookie);
    await a.page.getByRole('button', { name: '与 android_bobby 的会话' }).click();
    await expect(a.page.locator('.bubble').filter({ hasText: text })).toBeVisible();
    a.setOffline(true); await a.restart();
    await expect(a.page.locator('#login-restore-status')).toContainText('已保留登录状态'); expect(a.hasSavedLogin()).toBe(true);
    a.setOffline(false); await a.page.locator('#retry-login').click(); await expect(a.page.locator('#chat-screen')).toBeVisible();
    await a.page.getByRole('button', { name: '与 android_bobby 的会话' }).click();
    await expect(a.page.locator('.bubble').filter({ hasText: text })).toBeVisible();
    expect(a.requests.filter(r => r.path === '/api/auth/login').length).toBe(loginRequests);
    await a.page.locator('#trust-notice').click(); await b.page.locator('#trust-notice').click();
    expect(await a.page.locator('#safety-code').innerText()).toBe(await b.page.locator('#safety-code').innerText());
    await a.page.locator('#mark-verified').click(); await b.page.locator('#mark-verified').click();
    await a.page.screenshot({ path: 'test-results/android/chat.png' });
    const png = await a.page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 120; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#235c51'; ctx.fillRect(0, 0, 200, 120); return canvas.toDataURL('image/png').split(',')[1]; });
    await a.page.locator('#image-input').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(b.page.getByRole('button', { name: '打开图片', exact: true })).toBeVisible({ timeout: 15000 });
    await b.page.getByRole('button', { name: '打开图片', exact: true }).click(); await expect(b.page.locator('#image-dialog')).toBeVisible();
    await b.page.evaluate(() => globalThis.whisperAndroidPause());
    await expect(b.page.locator('#image-dialog')).not.toBeVisible(); await expect(b.page.locator('#view-image')).not.toHaveAttribute('src', /.+/);
    const requestCount = b.requests.length; await b.page.waitForTimeout(2600); expect(b.requests.length).toBe(requestCount);
    await b.page.evaluate(() => globalThis.whisperAndroidResume());
    await expect(b.page.getByRole('button', { name: '打开图片', exact: true })).toHaveCount(0);
    expect(app.db.prepare("SELECT ciphertext FROM messages WHERE type='image'").get().ciphertext).toBe(null);
    await a.page.locator('#image-input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(b.page.getByRole('button', { name: '打开图片', exact: true })).toBeVisible({ timeout: 15000 });
    await b.page.getByRole('button', { name: '打开图片', exact: true }).click();
    await expect(b.page.locator('#image-countdown')).toContainText('3 秒');
    await expect(b.page.locator('#view-image')).not.toHaveAttribute('src', /.+/, { timeout: 3800 });
    await expect(b.page.locator('#image-dialog')).not.toBeVisible({ timeout: 1500 });
    await expect(b.page.locator('#view-image')).toHaveCount(1);
    await expect(b.page.getByRole('button', { name: '打开图片', exact: true })).toHaveCount(0);
    await a.page.locator('#chat-back').click(); await a.page.screenshot({ path: 'test-results/android/conversations.png' });
    await a.page.locator('#nav-my').click(); await a.page.locator('#account-settings').click();
    await a.page.locator('#old-password').fill(password); await a.page.locator('#new-password').fill('NewAndroid!');
    await a.page.locator('#repeat-password').fill('NewAndroid!'); await a.page.locator('#password-submit').click();
    await expect(a.page.locator('#auth-screen')).toBeVisible(); await expect(a.page.locator('#new-password')).toHaveValue('');
    expect(a.clears()).toBeGreaterThan(0); expect(a.getCookie()).toBe('');
    await b.page.locator('#chat-back').click(); await b.page.locator('#nav-my').click(); await b.page.locator('#logout').click();
    await expect(b.page.locator('#auth-screen')).toBeVisible();
    expect(b.getCookie()).toBe(''); await expect(b.page.locator('.bubble')).toHaveCount(0);
    expect(b.hasSavedLogin()).toBe(false); await b.restart(); await expect(b.page.locator('#auth-screen')).toBeVisible();
    const storage = await b.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    expect(Object.keys(storage).every(key => key.startsWith('whisper:public-key-pins:'))).toBe(true);
    expect(JSON.stringify(storage)).not.toContain(password); expect(JSON.stringify(storage)).not.toContain(text);
    expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await Promise.all([a.context.close(), b.context.close()]); }
});
