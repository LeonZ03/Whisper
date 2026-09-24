import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWhisperServer } from '../server/app.mjs';
let app, dir;
test.beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'whisper-browser-')); app = await createWhisperServer({ dataDir: dir, port: 0 }); mkdirSync('test-results', { recursive: true }); });
test.afterAll(async () => { await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
test('两个浏览器真实加密聊天、图片、删除、越权及跨入口登录', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()]);
  const [a, b, c, d] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
  const failures = []; const network = [];
  for (const page of [a, b, c, d]) { page.on('pageerror', (e) => failures.push(e.message)); page.on('dialog', (dialog) => dialog.accept()); }
  a.on('request', (request) => { if (request.method() === 'POST') network.push(request.postData() || ''); });
  const password = 'Browser26!';
  async function apply(page, username) {
    await page.goto(app.localUrl); await expect(page.locator('#auth-submit')).toBeEnabled();
    await page.locator('#register-tab').click(); await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#auth-submit').click(); await expect(page.locator('#toast')).toContainText('等待管理员审批');
  }
  async function login(page, username) {
    await page.goto(app.localUrl); await expect(page.locator('#auth-submit')).toBeEnabled();
    await page.locator('#username').fill(username); await page.locator('#password').fill(password);
    await page.locator('#auth-submit').click(); await expect(page.locator('#chat-screen')).toBeVisible({ timeout: 30000 });
  }
  try {
    await a.goto(app.localUrl); await expect(a.locator('#auth-submit')).toBeEnabled();
    await a.screenshot({ path: 'test-results/login-desktop.png', fullPage: true });
    await apply(a, 'alice_demo'); await apply(b, 'bobby_demo'); await apply(c, 'carol_demo');
    for (const username of ['alice_demo','bobby_demo','carol_demo']) app.db.prepare("UPDATE users SET status='active', reviewed_at=? WHERE username=? AND status='pending'").run(Date.now(), username);
    await login(a, 'alice_demo'); await login(b, 'bobby_demo'); await login(c, 'carol_demo');
    await a.locator('#peer-name').fill('bobby_demo'); await a.getByRole('button', { name: '开始会话', exact: true }).click();
    await expect(a.locator('#peer-title')).toHaveText('bobby_demo');
    await b.getByRole('button', { name: '与 alice_demo 的会话' }).click({ timeout: 10000 });
    await expect(b.locator('#peer-title')).toHaveText('alice_demo');
    const text = '你好，这是仅在浏览器解开的测试消息。 <img src=x onerror=alert(1)>';
    await a.locator('#message-input').fill(text); await a.locator('#send').click();
    await expect(b.locator('.bubble').filter({ hasText: text })).toBeVisible({ timeout: 10000 });
    expect(await b.locator('.bubble img').count()).toBe(0);
    await expect(a.locator('.message-countdown').first()).toContainText('剩余');
    await expect(b.locator('.message-countdown').first()).toContainText('剩余');
    expect(network.join('\n')).not.toContain(text); expect(network.join('\n')).not.toContain(password);
    expect(readFileSync(join(dir, 'whisper.sqlite')).includes(Buffer.from(text))).toBe(false);
    await a.locator('#verify').click(); await b.locator('#verify').click();
    expect(await a.locator('#safety-code').innerText()).toBe(await b.locator('#safety-code').innerText());
    await a.locator('#mark-verified').click(); await b.locator('#mark-verified').click();
    const convId = await a.locator('.conversation-item.selected').getAttribute('data-conversation-id');
    const status = await c.evaluate(async (id) => (await fetch(`/api/conversations/${id}/messages`)).status, convId); expect(status).toBe(404);
    await b.locator('#message-input').fill('收到了。两个入口共享服务，聊天内容在本机解密。'); await b.locator('#send').click();
    await expect(a.locator('.bubble').filter({ hasText: '收到了。' })).toBeVisible({ timeout: 10000 });
    await a.screenshot({ path: 'test-results/chat-desktop.png', fullPage: true });
    const png = await a.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dce9de'; ctx.fillRect(0, 0, 240, 160); ctx.fillStyle = '#235c51'; ctx.font = '24px sans-serif'; ctx.fillText('Whisper test', 35, 85); return canvas.toDataURL('image/png').split(',')[1]; });
    await a.locator('#image-input').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(b.getByRole('button', { name: '打开图片', exact: true })).toBeVisible({ timeout: 10000 });
    await b.getByRole('button', { name: '打开图片', exact: true }).click(); await expect(b.locator('#image-dialog')).toBeVisible();
    await b.screenshot({ path: 'test-results/view-once.png', fullPage: true });
    await b.locator('#close-image').click(); await expect(b.locator('#image-dialog')).not.toBeVisible();
    await expect(b.getByRole('button', { name: '打开图片', exact: true })).toHaveCount(0);
    expect(app.db.prepare("SELECT ciphertext FROM messages WHERE type='image'").get().ciphertext).toBe(null);
    const alternative = app.localUrl.replace('127.0.0.1', 'localhost'); await d.goto(alternative);
    await expect(d.locator('#auth-submit')).toBeEnabled(); await d.locator('#username').fill('alice_demo'); await d.locator('#password').fill(password); await d.locator('#auth-submit').click();
    await expect(d.locator('#chat-screen')).toBeVisible({ timeout: 30000 }); await d.getByRole('button', { name: '与 bobby_demo 的会话' }).click();
    await expect(d.locator('.bubble').filter({ hasText: text })).toBeVisible({ timeout: 10000 });
    await a.locator('article').filter({ hasText: text }).getByRole('button', { name: '双方删除', exact: true }).click();
    await expect(b.locator('.bubble').filter({ hasText: text })).toHaveCount(0, { timeout: 10000 });
    await a.locator('#clear-chat').click(); await expect(b.locator('article')).toHaveCount(0, { timeout: 10000 });
    await d.setViewportSize({ width: 390, height: 844 }); await d.screenshot({ path: 'test-results/chat-mobile.png', fullPage: true });
    expect(await d.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(failures).toEqual([]);
  } finally { await Promise.all(contexts.map((ctx) => ctx.close())); }
});
