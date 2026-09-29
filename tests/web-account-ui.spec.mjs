import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Real Web markup with isolated component APIs; no accounts or network services.
const html = readFileSync('public/index.html', 'utf8').replace('<script type="module" src="/app.js"></script>', '');
const styles = readFileSync('public/style.css', 'utf8');
const modules = Object.fromEntries(['web-account-ui', 'account-sessions-ui', 'message-lifecycle'].map(name => [`/src/${name}.mjs`, readFileSync(`src/${name}.mjs`, 'utf8')]));
const logo = readFileSync('public/brand-mark.svg', 'utf8');

test.beforeEach(async ({ page }) => {
  await page.route('https://whisper.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (modules[path]) return route.fulfill({ contentType: 'text/javascript', body: modules[path] });
    if (path === '/style.css') return route.fulfill({ contentType: 'text/css', body: styles });
    if (path === '/brand-mark.svg' || path === '/favicon.svg') return route.fulfill({ contentType: 'image/svg+xml', body: logo });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('https://whisper.test/');
  await page.evaluate(async () => {
    const $ = id => document.getElementById(id);
    window.initialStartup = { startup: !$('web-startup').hidden, auth: !$('auth-screen').hidden };
    window.currentUser = { id: 'isolated-member', username: 'web_demo', role: 'member' };
    window.sessionPayload = {
      sessions: [{ method: 'web', device: 'Edge / Windows', current: true, status: 'active', createdAt: '2026-09-29T01:00:00Z', ip: '192.0.2.20', location: { country: 'CN', region: '上海' } }],
      history: Array.from({ length: 12 }, (_, index) => ({ method: index % 3 === 1 ? 'app' : index % 3 === 2 ? 'cli' : 'web', device: index === 0 ? 'Edge / Windows' : index === 1 ? 'OPPO PKB110 / Android 15' : `设备 ${index}`, current: index === 0, status: index < 3 ? 'active' : 'logout', createdAt: '2026-09-29T01:00:00Z', ...(index >= 3 ? { endedAt: '2026-09-29T01:30:00Z' } : {}), ip: `192.0.2.${20 + index}`, location: { country: 'CN', region: '上海' } }))
    };
    window.apiCalls = []; window.leaveCount = 0; window.passwordOpens = 0; window.logoutClicks = 0;
    $('account-settings').onclick = () => { window.passwordOpens++; $('password-dialog').showModal(); };
    $('password-close').onclick = () => $('password-dialog').close();
    $('logout').onclick = () => window.logoutClicks++;
    $('entry-kind').textContent = '云端服务';
    $('chat-screen').querySelector('[data-app-version]').textContent = 'v0.5.5';
    // Mirror accountUI's existing initial reparenting before the Web module mounts.
    $('chat-screen').append($('admin-panel'));
    const { createWebAccountUI } = await import('/src/web-account-ui.mjs');
    window.ui = createWebAccountUI({ getSelf: () => window.currentUser, api: async path => { window.apiCalls.push(path); return window.fetchSessions ? window.fetchSessions() : window.sessionPayload; }, onLeaveChat: () => window.leaveCount++ });
    $('web-startup').hidden = true; $('chat-screen').hidden = false;
    window.ui.enter(window.currentUser);
  });
});

test('My exposes account, actual service, current device and privacy using existing actions', async ({ page }) => {
  expect(await page.evaluate(() => window.initialStartup)).toEqual({ startup: true, auth: false });
  await page.locator('#nav-my').click();
  await expect(page.locator('#my-title')).toBeFocused();
  await expect(page.locator('#my-name')).toHaveText('web_demo');
  await expect(page.locator('#my-role')).toHaveText('云端账号');
  await expect(page.locator('#my-service-kind')).toHaveText('云端服务');
  await expect(page.locator('#my-service-host')).toHaveText('whisper.test');
  await expect(page.locator('#my-web-version')).toHaveText('v0.5.5');
  await expect(page.locator('#chat-screen [data-app-version]')).toHaveCount(1);
  await expect(page.locator('#current-device-name')).toHaveText('Edge / Windows');
  await expect(page.locator('#nav-my')).toHaveAttribute('aria-current', 'page');
  await page.locator('#account-settings').click();
  await expect(page.locator('#password-dialog')).toBeVisible();
  expect(await page.evaluate(() => window.passwordOpens)).toBe(1);
  await page.locator('#password-close').click();
  await page.locator('#privacy-button').click();
  await expect(page.locator('#privacy-dialog')).toBeVisible();
  await expect(page.locator('#privacy-dialog')).toContainText('不能阻止截图');
  await page.keyboard.press('Escape');
  await expect(page.locator('#privacy-dialog')).not.toBeVisible();
  await expect(page.locator('#privacy-button')).toBeFocused();
  await page.locator('#logout').click();
  expect(await page.evaluate(() => window.logoutClicks)).toBe(1);
  expect(await page.evaluate(() => window.apiCalls.every(path => path === '/api/account/sessions'))).toBe(true);
});

test('device history caps ten records and scrolls below a fixed back header on phone and desktop', async ({ page }) => {
  await page.locator('#nav-my').click();
  await page.locator('#account-devices-open').click();
  await expect(page.locator('#device-history-title')).toBeFocused();
  await expect(page.locator('.session-item')).toHaveCount(10);
  await expect(page.locator('#device-history-list')).toContainText('OPPO Find X8');
  await expect(page.locator('#device-history-list')).toContainText('退出时间');
  await expect(page.locator('#device-history-list')).toContainText('已退出');
  for (const viewport of [{ width: 1365, height: 900 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    const before = await page.locator('.web-history-header').boundingBox();
    await page.locator('#device-history-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const after = await page.locator('.web-history-header').boundingBox();
    expect(after.y).toBe(before.y);
    expect(await page.locator('#device-history-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#device-history-back')).toBeInViewport();
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#my-panel')).toBeVisible();
  await expect(page.locator('#account-devices-open')).toBeFocused();
});

test('navigation preserves draft, caret, message DOM and ongoing absolute expiry', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-29T00:00:00Z') });
  await page.evaluate(async () => {
    const { MessageLifecycle } = await import('/src/message-lifecycle.mjs');
    document.getElementById('empty-state').hidden = true;
    document.getElementById('conversation-panel').hidden = false;
    window.messageOriginal = document.createElement('article'); window.messageOriginal.className = 'message';
    const body = document.createElement('div'); body.className = 'bubble'; body.textContent = '到期必须清理的测试消息';
    const timer = document.createElement('span'); window.messageOriginal.append(body, timer);
    document.getElementById('messages').append(window.messageOriginal);
    window.lifecycle = new MessageLifecycle(document.getElementById('messages'));
    window.lifecycle.track('isolated-expiry', window.messageOriginal, Date.now() + 5000, timer);
  });
  await page.locator('#message-input').fill('未提交的草稿');
  await page.locator('#message-input').evaluate(el => el.setSelectionRange(2, 4));
  await page.locator('#nav-my').click();
  await expect(page.locator('#message-input')).toHaveValue('未提交的草稿');
  expect(await page.evaluate(() => document.querySelector('.message') === window.messageOriginal)).toBe(true);
  await page.clock.fastForward(5400);
  expect(await page.locator('#messages').textContent()).not.toContain('到期必须清理的测试消息');
  await page.locator('#nav-conversations').click();
  await expect(page.locator('#message-input')).toBeFocused();
  await expect(page.locator('#message-input')).toHaveValue('未提交的草稿');
  expect(await page.locator('#message-input').evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 4]);
  expect(await page.evaluate(() => window.leaveCount)).toBe(1);
});

test('server metadata is text and a late session response cannot repopulate after clear', async ({ page }) => {
  await page.evaluate(() => {
    const malicious = '<img src=x onerror=alert(1)>';
    window.currentUser.username = malicious;
    window.sessionPayload.sessions[0].device = malicious;
    window.sessionPayload.history[0].device = malicious;
    window.ui.enter(window.currentUser);
  });
  await page.locator('#nav-my').click();
  await expect(page.locator('#my-name')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#current-device-name')).toHaveText('<img src=x onerror=alert(1)>');
  await page.locator('#account-devices-open').click();
  await expect(page.locator('#device-history-list')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#my-panel img, #device-history-panel img')).toHaveCount(0);
  await page.evaluate(() => { window.fetchSessions = () => new Promise(resolve => window.resolveSessions = resolve); window.ui.resume(); });
  await expect(page.locator('#device-history-list')).toContainText('正在读取设备');
  await page.evaluate(() => { window.currentUser = null; window.ui.clear(); window.resolveSessions(window.sessionPayload); window.ui.show('my'); window.ui.resume(); });
  await expect(page.locator('#device-history-list')).toBeEmpty();
  await expect(page.locator('#my-name')).toBeEmpty();
  await expect(page.locator('#my-panel')).not.toBeVisible();
  await expect(page.locator('#privacy-dialog')).not.toBeVisible();
});

test('root management remains in the responsive content area and reachable from My', async ({ page }) => {
  await page.evaluate(() => { window.currentUser = { id: 'isolated-root', username: 'root', role: 'root' }; window.ui.enter(window.currentUser); });
  await expect(page.locator('#web-content > #admin-panel')).toBeVisible();
  await expect(page.locator('#nav-conversations')).toHaveText('管理');
  await expect(page.locator('#chat-body')).not.toBeVisible();
  await page.locator('#nav-my').click();
  await expect(page.locator('#my-role')).toHaveText('云端管理员');
  await page.locator('#nav-conversations').click();
  await expect(page.locator('#admin-panel')).toBeVisible();
  await expect(page.locator('#nav-conversations')).toHaveAttribute('aria-current', 'page');
});
