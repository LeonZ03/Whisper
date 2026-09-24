import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Isolated browser component tests; no real accounts, services, or user data.
const moduleSource = readFileSync('src/message-lifecycle.mjs', 'utf8');
const styles = readFileSync('public/style.css', 'utf8');
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-24T00:00:00Z') });
  await page.route('https://whisper.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/lifecycle.mjs') return route.fulfill({ contentType: 'text/javascript', body: moduleSource });
    if (path === '/style.css') return route.fulfill({ contentType: 'text/css', body: styles });
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
