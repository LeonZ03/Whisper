import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Isolated browser component tests; no real accounts, services, or user data.
const moduleSource = readFileSync('src/message-lifecycle.mjs', 'utf8');
const sessionsModuleSource = readFileSync('src/account-sessions-ui.mjs', 'utf8');
const styles = readFileSync('public/style.css', 'utf8');
const androidStyles = readFileSync('android/web/style.css', 'utf8');
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-24T00:00:00Z') });
  await page.route('https://whisper.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/lifecycle.mjs') return route.fulfill({ contentType: 'text/javascript', body: moduleSource });
    if (path === '/sessions.mjs') return route.fulfill({ contentType: 'text/javascript', body: sessionsModuleSource });
    if (path === '/style.css') return route.fulfill({ contentType: 'text/css', body: styles });
    if (path === '/android.css') return route.fulfill({ contentType: 'text/css', body: androidStyles });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="messages" class="messages" style="height:420px;flex:none"></div><textarea id="draft"></textarea>' });
  });
  await page.goto('https://whisper.test/');
  await page.evaluate(async () => {
    const { MessageLifecycle } = await import('/lifecycle.mjs');
    window.retired = []; window.lifecycle = new MessageLifecycle(document.getElementById('messages'), (id) => window.retired.push(id));
    window.addCard = (id, ttl, consumed = false) => {
      const el = document.createElement('article'); el.className = 'message'; el.dataset.messageId = id;
      const body = document.createElement('div'); body.className = 'bubble'; body.textContent = '测试内容 ' + id;
      const timer = document.createElement('span'); timer.className = 'message-countdown'; timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off');
      el.append(body, timer); document.getElementById('messages').append(el);
      window.lifecycle.track(id, el, Date.now() + ttl, timer, consumed); return el;
    };
  });
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 100)));
});
test('absolute countdown updates without remounting, focus loss, or network requests', async ({ page }) => {
  let requests = 0; page.on('request', () => requests++);
  await page.evaluate(() => { window.original = window.addCard('clock', 65000); });
  const timer = page.locator('.message-countdown');
  await expect(timer).toHaveText('剩余 00:01:05');
  await page.locator('#draft').fill('倒计时刷新时保留草稿');
  await page.clock.runFor(5000); await expect(timer).toHaveText('剩余 00:01:00');
  await expect(timer).toHaveClass(/expiring-soon/);
  await page.clock.fastForward(50000); await expect(timer).toHaveText('剩余 00:00:10');
  await expect(timer).toHaveClass(/expiring-now/);
  expect(await page.evaluate(() => window.original === document.querySelector('.message'))).toBe(true);
  await expect(page.locator('#draft')).toBeFocused(); await expect(page.locator('#draft')).toHaveValue('倒计时刷新时保留草稿');
  expect(requests).toBe(0);
});
test('expiry scrubs content before the short empty-shell animation, then removes the card', async ({ page }) => {
  await page.evaluate(() => {
    window.original = window.addCard('secret', 5000);
    window.erased = [];
    window.lifecycle.onRetire = (id) => window.erased.push({ id, text: window.original.textContent, inert: window.original.inert });
  });
  await page.clock.fastForward(5001);
  expect(await page.evaluate(() => window.erased)).toEqual([{ id: 'secret', text: '', inert: true }]);
  expect(await page.locator('#messages').innerText()).not.toContain('测试内容 secret');
  await page.clock.runFor(400); await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.locator('.messages-empty')).toBeVisible();
});

test('view-once image dissolve clears its source before animation and can be cancelled', async ({ page }) => {
  const state = await page.evaluate(async () => {
    const { dissolveViewOnceImage } = await import('/lifecycle.mjs');
    const image = document.createElement('img'); image.src = 'data:image/png;base64,AA==';
    document.body.append(image); let completed = 0;
    const cancel = dissolveViewOnceImage(image, { onComplete: () => completed++ });
    const scrubbed = image.hidden && !image.hasAttribute('src') && !image.hasAttribute('srcset') && document.querySelector('.image-dissolve-shell')?.querySelectorAll('.dissolve-particle').length === 3;
    cancel();
    return { scrubbed, completed, shellCount: document.querySelectorAll('.image-dissolve-shell').length, imageVisible: !image.hidden };
  });
  expect(state).toEqual({ scrubbed: true, completed: 0, shellCount: 0, imageVisible: true });
});

test('view-once image dissolve completes immediately with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await page.evaluate(async () => {
    const { dissolveViewOnceImage } = await import('/lifecycle.mjs');
    const image = document.createElement('img'); image.src = 'data:image/png;base64,AA=='; document.body.append(image);
    let completed = 0; dissolveViewOnceImage(image, { onComplete: () => completed++ });
    return { completed, imageCount: document.querySelectorAll('img').length, imageHasSource: image.hasAttribute('src'), imageVisible: !image.hidden, shellCount: document.querySelectorAll('.image-dissolve-shell').length };
  });
  expect(state).toEqual({ completed: 1, imageCount: 1, imageHasSource: false, imageVisible: true, shellCount: 0 });
});

test('account sessions render metadata as text and expose current and legacy states', async ({ page }) => {
  await page.evaluate(async () => {
    const { createAccountSessionsUI } = await import('/sessions.mjs');
    const root = document.createElement('div'); document.body.append(root);
    window.sessionsUI = createAccountSessionsUI({ root, fetchImpl: async () => ({ ok: true, json: async () => ({ sessions: [
      { method: 'app', device: '<img src=x onerror=alert(1)>', createdAt: '2026-09-24T00:00:00Z', ip: '192.0.2.1', current: true },
      { method: 'unknown', createdAt: null, ip: null, current: false }
    ] }) }) });
    await window.sessionsUI.load();
  });
  await expect(page.locator('body')).toContainText('本机');
  await expect(page.locator('body')).toContainText('未知旧会话');
  await expect(page.locator('body')).toContainText('192.0.2.1');
  await expect(page.locator('body img')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('<img src=x onerror=alert(1)>');
});

test('account sessions fit a 375px phone and landscape with reduced motion', async ({ page }) => {
  await page.addStyleTag({ content: androidStyles });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => {
    document.body.innerHTML = '<main class="app-shell" data-view="my"><section class="my-panel"><div class="my-scroll"><h1>我的</h1><section class="settings-section account-sessions"><h2>已登录设备</h2><ul class="session-list"><li class="session-item"><div class="session-heading"><strong>Pixel Android</strong><span class="session-current">本机</span></div><p class="session-details">Android App · 2026年9月24日 08:00 · IP 192.0.2.10</p></li></ul></section><article class="message message-retiring"><div class="message-expired-shell">消息已到期</div></article></div></section></main>';
  });
  const phone = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, animation: getComputedStyle(document.querySelector('.message-retiring')).animationName, text: document.querySelector('.session-details').getBoundingClientRect().width }));
  expect(phone.width).toBeLessThanOrEqual(phone.viewport);
  expect(phone.animation).toBe('none');
  expect(phone.text).toBeGreaterThan(0);
  await page.setViewportSize({ width: 812, height: 375 });
  const landscape = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, sessions: document.querySelector('.account-sessions').getBoundingClientRect() }));
  expect(landscape.width).toBeLessThanOrEqual(landscape.viewport);
  expect(landscape.sessions.width).toBeGreaterThan(0);
});

test('late account-session responses cannot repopulate cleared or newer session data', async ({ page }) => {
  await page.evaluate(async () => {
    const { createAccountSessionsUI } = await import('/sessions.mjs');
    const root = document.createElement('div'); document.body.append(root);
    const pending = [];
    window.pendingSessionRequests = pending;
    window.sessionsUI = createAccountSessionsUI({ root, fetchImpl: () => new Promise(resolve => pending.push(resolve)) });
    const response = (device, ip) => ({ ok: true, json: async () => ({ sessions: [
      { method: 'web', device, ip, createdAt: '2026-09-24T00:00:00Z', current: true }
    ] }) });

    const clearedRequest = window.sessionsUI.load();
    window.sessionsUI.clear();
    pending[0](response('Cleared account device', '192.0.2.11'));
    await clearedRequest;
    window.clearedResponseText = root.textContent;

    const oldRequest = window.sessionsUI.load();
    const newRequest = window.sessionsUI.load();
    pending[2](response('Current account device', '192.0.2.22'));
    await newRequest;
    pending[1](response('Stale account device', '192.0.2.33'));
    await oldRequest;
  });
  expect(await page.evaluate(() => window.clearedResponseText)).toBe('');
  await expect(page.locator('body')).toContainText('Current account device');
  await expect(page.locator('body')).toContainText('192.0.2.22');
  await expect(page.locator('body')).not.toContainText('Cleared account device');
  await expect(page.locator('body')).not.toContainText('192.0.2.11');
  await expect(page.locator('body')).not.toContainText('Stale account device');
  await expect(page.locator('body')).not.toContainText('192.0.2.33');
});
