import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhisperServer } from '../server/app.mjs';
import WebSocket from 'ws';
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
  let cookie = '', requests = [], clears = 0, savedLogin = null, offline = false, restoreGate = null;
  const realtimeSockets = new Set(), realtimeFailures = [];
  // Keep the packaged client's fixed WSS endpoint and exact CSP. Playwright
  // routes that endpoint to an isolated real WebSocket handshake; no production
  // connection or account is used. This is browser bridge coverage, not a device test.
  await context.routeWebSocket('wss://whisper.leonz03.dpdns.org/api/realtime', route => {
    const endpoint = new URL('/api/realtime', app.localUrl); endpoint.protocol = 'ws:';
    const socket = new WebSocket(endpoint, route.protocols(), { origin: 'https://appassets.androidplatform.net' });
    realtimeSockets.add(socket); const pending = [];
    socket.on('open', () => { for (const message of pending.splice(0)) socket.send(message); });
    socket.on('message', (data, binary) => route.send(binary ? data : data.toString()));
    socket.on('error', () => { realtimeFailures.push('隔离实时握手失败'); void route.close({ code: 1011 }); });
    socket.on('close', (code) => { realtimeSockets.delete(socket); void route.close({ code: code === 1005 || code === 1006 ? 1000 : code }); });
    route.onMessage(message => { if (socket.readyState === WebSocket.OPEN) socket.send(message); else if (socket.readyState === WebSocket.CONNECTING && pending.length < 4) pending.push(message); });
    route.onClose(() => { if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close(); });
  });
  await context.exposeBinding('androidRequest', async ({ page }, id, path, method, body) => {
    requests.push({ path, method, body });
    if (path === '/api/account/me' && restoreGate) await restoreGate;
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
    globalThis.authScreenSeen = false;
    new MutationObserver(() => {
      const auth = document.getElementById('auth-screen');
      if (auth && !auth.hidden) globalThis.authScreenSeen = true;
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    globalThis.WhisperNative = {
      checkUpdate: manual => { globalThis.updateCheckManual = manual; },
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
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; connect-src wss://whisper.leonz03.dpdns.org/api/realtime; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    } });
  });
  const page = await context.newPage(); page.on('dialog', dialog => dialog.accept());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://appassets.androidplatform.net/index.html'); await expect(page.locator('#auth-submit')).toBeEnabled();
  return { context, page, errors, requests, realtimeFailures, realtimeSockets, getCookie: () => cookie, clears: () => clears, hasSavedLogin: () => Boolean(savedLogin),
    restart: async () => { cookie = ''; await page.reload({ waitUntil: 'commit' }); }, setOffline: value => { offline = value; },
    holdRestore: () => { let release; restoreGate = new Promise(resolve => { release = resolve; }); return () => { restoreGate = null; release(); }; } };
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
    await a.page.locator('#app-update').click();
    expect(await a.page.evaluate(() => globalThis.updateCheckManual)).toBe(true);
    await expect(a.page.locator('#account-sessions')).toContainText('OPPO test');
    await expect(a.page.locator('#account-sessions')).toContainText('本机');
    await expect(a.page.locator('#account-sessions')).not.toContainText('Android App');
    await expect(a.page.locator('#account-sessions')).not.toContainText('127.0.0.1');
    expect(await a.page.locator('#service-settings .setting-row').evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe('0px');
    expect(await a.page.locator('#account-sessions').evaluate(el => el.getBoundingClientRect().bottom <= document.getElementById('service-settings').getBoundingClientRect().top)).toBe(true);
    expect(await a.page.locator('#privacy-button').evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe('0px');
    await a.page.screenshot({ path: 'test-results/android/my.png' });
    const historyOwner = app.db.prepare('SELECT id FROM users WHERE username=?').get('android_alice').id;
    for (let i = 1; i <= 12; i++) app.db.prepare('INSERT INTO login_history(id,user_id,method,device,ip,location,created_at,expires_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      `history-fixture-${i}`, historyOwner, i % 2 ? 'web' : 'cli', i % 2 ? 'Edge / Windows' : 'CLI / Windows', `192.0.2.${i}`,
      JSON.stringify({ country: 'CN', city: '上海' }), Date.now() - i * 3600000, Date.now() + 3600000, Date.now() - i * 3600000 + 60000, 'logout');
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM login_history WHERE user_id=?').get(historyOwner).n).toBe(10);
    await a.page.locator('#account-devices-open').click();
    await expect(a.page.locator('#device-history-panel')).toBeVisible(); await expect(a.page.locator('#mobile-nav')).not.toBeVisible();
    await expect(a.page.locator('#device-history-list .session-item')).toHaveCount(10);
    await expect(a.page.locator('#device-history-list')).toContainText('127.0.0.1');
    await expect(a.page.locator('#device-history-list')).toContainText('已退出');
    await expect(a.page.locator('#device-history-list')).toContainText('中国 · 上海');
    await a.page.screenshot({ path: 'test-results/android/device-history.png' });
    const headerTop = await a.page.locator('.device-history-header').evaluate(el => el.getBoundingClientRect().top);
    await a.page.locator('#device-history-list .session-item').last().scrollIntoViewIfNeeded();
    expect(await a.page.locator('#device-history-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await a.page.locator('.device-history-header').evaluate(el => el.getBoundingClientRect().top)).toBe(headerTop);
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.page.evaluate(() => globalThis.whisperAndroidBack()); await expect(a.page.locator('#my-panel')).toBeVisible();
    await expect(a.page.locator('#account-devices-open')).toBeFocused();
    await a.page.locator('#privacy-button').click(); await expect(a.page.locator('#privacy-dialog')).toBeVisible();
    await a.page.evaluate(() => globalThis.whisperAndroidBack()); await expect(a.page.locator('#privacy-dialog')).not.toBeVisible();
    await a.page.locator('#nav-conversations').click(); await a.page.locator('#peer-name').fill('android_bobby');
    await a.page.getByRole('button', { name: '开始会话', exact: true }).click();
    await expect(a.page.locator('#chat-screen')).toHaveAttribute('data-view', 'chat');
    await expect(a.page.locator('#mobile-nav')).not.toBeVisible();
    await b.page.getByRole('button', { name: '与 android_alice 的会话' }).click();
    const text = '安卓端消息 <img src=x onerror=alert(1)>'; await a.page.locator('#message-input').fill(text); await a.page.locator('#send').click();
    await expect(b.page.locator('.bubble').filter({ hasText: text })).toBeVisible({ timeout: 15000 });
    expect(a.requests.some(request => request.path.startsWith('/api/sync'))).toBe(true);
    expect(b.requests.some(request => request.path.startsWith('/api/sync'))).toBe(true);
    await expect.poll(() => b.realtimeSockets.size).toBe(1);
    const syncedRequests = b.requests.filter(request => request.path.startsWith('/api/sync')).length;
    await b.page.waitForTimeout(2300);
    expect(b.requests.filter(request => request.path.startsWith('/api/sync')).length).toBe(syncedRequests);
    expect(a.requests.some(request => /\/api\/conversations\/[^/]+\/messages$/.test(request.path) && request.method === 'GET')).toBe(false);
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
    const releaseRestore = a.holdRestore();
    try {
      await a.restart(); await expect(a.page.locator('#chat-screen')).toBeVisible();
      await expect(a.page.locator('#login-restore-status')).toHaveText('正在同步会话…');
      await expect(a.page.locator('#auth-screen')).not.toBeVisible();
      await expect(a.page.locator('.bubble')).toHaveCount(0);
      expect(await a.page.evaluate(() => globalThis.authScreenSeen)).toBe(false);
      expect(await a.page.locator('#new-chat-form').evaluate(el => el.inert)).toBe(true);
    } finally { releaseRestore(); }
    await expect(a.page.locator('#login-restore-status')).toHaveCount(0);
    expect(a.requests.filter(r => r.path === '/api/auth/login').length).toBe(loginRequests);
    expect(a.getCookie()).toBe(originalCookie);
    await a.page.getByRole('button', { name: '与 android_bobby 的会话' }).click();
    await expect(a.page.locator('.bubble').filter({ hasText: text })).toBeVisible();
    a.setOffline(true); await a.restart();
    await expect(a.page.locator('#login-restore-status')).toContainText('已保留登录状态'); expect(a.hasSavedLogin()).toBe(true);
    await expect(a.page.locator('#chat-screen')).toBeVisible(); await expect(a.page.locator('#auth-screen')).not.toBeVisible();
    expect(await a.page.evaluate(() => globalThis.authScreenSeen)).toBe(false);
    a.setOffline(false); await a.page.locator('#retry-login').click(); await expect(a.page.locator('#login-restore-status')).toHaveCount(0);
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
    await login(b, 'android_bobby');
    app.db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)').run('android_bobby');
    await b.restart(); await expect(b.page.locator('#auth-screen')).toBeVisible();
    await expect(b.page.locator('#chat-screen')).not.toBeVisible(); expect(b.hasSavedLogin()).toBe(false);
    const storage = await b.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    expect(Object.keys(storage).every(key => key.startsWith('whisper:public-key-pins:'))).toBe(true);
    expect(JSON.stringify(storage)).not.toContain(password); expect(JSON.stringify(storage)).not.toContain(text);
    expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await Promise.all([a.context.close(), b.context.close()]); }
});
