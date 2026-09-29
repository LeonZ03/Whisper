import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Isolated UI/protocol fixture. Crypto behavior is covered by crypto.test.mjs;
// these synthetic envelopes deliberately render deterministic fixture strings.
const cryptoStub = `export const ready=Promise.resolve();
export const b64=()=>'',unb64=()=>new Uint8Array(32),wipe=()=>{},randomSalt=()=>'';
export const deriveCredentials=async()=>({}),createIdentity=()=>({}),unlockIdentity=()=>new Uint8Array(32),rewrapIdentity=()=>({});
export const encryptMessage=()=>({}),decryptMessage=m=>({body:m.ciphertext}),safetyCode=async()=>'';`;
const user = { id: 'fixture-user', username: 'alice', publicKey: 'alice-key', role: 'member', mustChangePassword: false };
const conversation = { id: '11111111-1111-4111-8111-111111111111', updatedAt: 1, peer: { id: 'fixture-peer', username: 'bobby', publicKey: 'peer-key' } };
const other = { id: '22222222-2222-4222-8222-222222222222', updatedAt: 2, peer: { id: 'fixture-other', username: 'carol', publicKey: 'other-key' } };
const envelope = (id, seq, type = 'text') => ({ id, seq, type, conversationId: conversation.id, senderId: 'fixture-peer', ciphertext: id, nonce: 'fixture', createdAt: Date.now(), expiresAt: Date.now() + 120_000, consumedAt: null });
const response = (extra = {}) => ({ version: 1, cursor: 10, reset: false, more: false, conversationId: conversation.id,
  conversations: [], removedConversations: [], messages: [], removed: [], serverTime: Date.now(), ...extra });

async function fixture(page) {
  const requests = [], queued = [];
  let snapshot = [], gate = null;
  await page.addInitScript(() => {
    globalThis.fixtureSockets = [];
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); globalThis.fixtureSockets.push(this); queueMicrotask(() => { if (!this.closed) this.dispatchEvent(new Event('open')); }); }
      send() {} close() { this.closed = true; this.dispatchEvent(new Event('close')); }
    };
  });
  await page.route('https://realtime.test/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.startsWith('/api/')) {
      requests.push(path + url.search);
      let value, status = 200;
      if (path === '/api/health') value = { capabilities: ['realtime-sync-v1'], environment: 'local' };
      else if (path === '/api/realtime/ticket') value = { ticket: 'T'.repeat(43), expiresAt: Date.now() + 60_000 };
      else if (path === '/api/sync') {
        if (gate) { const current = gate; gate = null; await current.promise; value = current.result; status = current.status; }
        else if (queued.length) value = queued.shift();
        else value = response({ reset: !url.searchParams.has('cursor'), conversationId: url.searchParams.get('conversationId'),
          conversations: [conversation, other], messages: url.searchParams.has('conversationId') ? snapshot : [] });
      } else if (path === '/api/account/sessions') value = { sessions: [] };
      else value = {};
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    }
    if (path === '/crypto.mjs') return route.fulfill({ contentType: 'text/javascript', body: cryptoStub });
    if (path === '/app.js') {
      const source = readFileSync('src/app.mjs', 'utf8').replaceAll('__APP_VERSION__', JSON.stringify('fixture')) + `
globalThis.realtimeTest={enterUser,selectConversation,sync,lock,stopRealtime,
state:()=>({cursor:syncCursor,selected:selected?.id,messages:messages.map(m=>m.id),running:realtime?.running,loggedIn:Boolean(self),id:self?.id}),
loadEarlier:items=>{messages=[...items,...messages];renderMessages()}};`;
      return route.fulfill({ contentType: 'text/javascript', body: source });
    }
    if (path.endsWith('.mjs')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join('src', path.substring(1)), 'utf8') });
    const file = path === '/' ? 'index.html' : path.substring(1);
    const body = readFileSync(join('public', file));
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html', body });
  });
  await page.goto('https://realtime.test/');
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.realtimeTest))).toBe(true);
  await page.evaluate(async user => { await realtimeTest.enterUser(user, new Uint8Array(32)); await realtimeTest.sync(); realtimeTest.stopRealtime(); }, user);
  return { requests, queued, snapshot: value => { snapshot = value; },
    hold: (result, status = 200) => { let release; gate = { result, status, promise: new Promise(resolve => { release = resolve; }) }; return release; } };
}

test('incremental removals reach loaded old pages; unchanged cards retain focus, draft and absolute expiry', async ({ page }) => {
  const f = await fixture(page); f.snapshot([envelope('recent', 201), envelope('image', 202, 'image')]);
  await page.evaluate(c => realtimeTest.selectConversation(c), conversation);
  await page.evaluate(item => { realtimeTest.loadEarlier([item]); window.originalCard = document.querySelector('[data-message-id="recent"]'); }, envelope('old-page', 1));
  await page.locator('#message-input').fill('未提交的草稿');
  const expiry = await page.locator('[data-message-id="recent"] time, [data-message-id="recent"] .message-meta span').first().getAttribute('title');
  f.queued.push(response({ cursor: 11, removed: ['old-page'], messages: [{ ...envelope('image', 202, 'image'), ciphertext: 'never-render-image-payload', consumedAt: Date.now() }] }));
  await page.evaluate(() => realtimeTest.sync());
  await expect(page.locator('[data-message-id="old-page"] .bubble')).toHaveCount(0);
  await expect(page.locator('[data-message-id="image"]')).toContainText('图片已清理');
  await expect(page.locator('body')).not.toContainText('never-render-image-payload');
  expect(await page.evaluate(() => window.originalCard === document.querySelector('[data-message-id="recent"]'))).toBe(true);
  await expect(page.locator('#message-input')).toBeFocused(); await expect(page.locator('#message-input')).toHaveValue('未提交的草稿');
  expect(await page.locator('[data-message-id="recent"] .message-meta span').first().getAttribute('title')).toBe(expiry);
  const count = f.requests.filter(path => path.startsWith('/api/sync')).length;
  await page.waitForTimeout(2300); expect(f.requests.filter(path => path.startsWith('/api/sync')).length).toBe(count);
  expect(f.requests.some(path => path.includes('/messages'))).toBe(false);
});

test('serial pages commit after apply; peer identity change blocks cached text and sealed conversations clear it', async ({ page }) => {
  const f = await fixture(page); f.snapshot([envelope('secret', 1)]);
  await page.evaluate(c => realtimeTest.selectConversation(c), conversation);
  f.queued.push(response({ cursor: 11, more: true, messages: [envelope('second', 2)] }), response({ cursor: 12, conversations: [{ ...conversation, peer: { ...conversation.peer, publicKey: 'recovered-key' } }] }));
  await page.evaluate(() => realtimeTest.sync());
  expect(await page.evaluate(() => realtimeTest.state().cursor)).toBe(12);
  expect(f.requests.slice(-2)[0]).toContain('cursor=10'); expect(f.requests.slice(-1)[0]).toContain('cursor=11');
  await expect(page.locator('#trust-notice')).toContainText('公钥发生变化'); await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('.bubble').first()).toHaveText('公钥变化，已阻止解密。');
  f.queued.push(response({ cursor: 13, conversationId: null, removedConversations: [conversation.id] }));
  await page.evaluate(() => realtimeTest.sync()); await expect(page.locator('.bubble')).toHaveCount(0);
  expect(await page.evaluate(() => realtimeTest.state().selected)).toBeUndefined(); expect(await page.evaluate(() => realtimeTest.state().cursor)).toBeNull();
});

test('a late old-conversation response cannot replace a newer selection or cursor', async ({ page }) => {
  const f = await fixture(page); f.snapshot([envelope('first-chat', 1)]);
  await page.evaluate(c => realtimeTest.selectConversation(c), conversation);
  const release = f.hold(response({ cursor: 999, messages: [envelope('stale-response', 3)] }));
  const old = page.evaluate(() => realtimeTest.sync());
  await expect.poll(() => f.requests.at(-1)).toContain('cursor=10');
  const next = page.evaluate(c => realtimeTest.selectConversation(c), other);
  await expect.poll(() => page.evaluate(() => realtimeTest.state().selected)).toBe(other.id);
  f.snapshot([{ ...envelope('second-chat', 2), conversationId: other.id }]); release();
  await Promise.all([old, next]);
  await expect(page.locator('.bubble')).toHaveText('second-chat');
  expect(await page.evaluate(() => realtimeTest.state().cursor)).toBe(10);
  await expect(page.locator('body')).not.toContainText('stale-response');
});

test('an old-account 401 cannot lock a new login; current revocation clears identity and displayed content', async ({ page }) => {
  const f = await fixture(page); f.snapshot([envelope('private-fixture', 1)]);
  await page.evaluate(c => realtimeTest.selectConversation(c), conversation);
  const release = f.hold({ error: 'old revoked' }, 401), count = f.requests.length;
  const old = page.evaluate(() => realtimeTest.sync());
  await expect.poll(() => f.requests.length).toBeGreaterThan(count);
  const nextUser = { ...user, id: 'second-user', publicKey: 'second-user-key' };
  const next = page.evaluate(async user => { realtimeTest.lock(); await realtimeTest.enterUser(user, new Uint8Array(32)); realtimeTest.stopRealtime(); }, nextUser);
  await expect.poll(() => page.evaluate(() => realtimeTest.state().id)).toBe(nextUser.id);
  release(); await Promise.all([old, next]);
  expect(await page.evaluate(() => realtimeTest.state().loggedIn)).toBe(true);
  const revoke = f.hold({ error: 'current revoked' }, 401);
  const request = page.evaluate(() => realtimeTest.sync()); revoke(); await request;
  expect(await page.evaluate(() => realtimeTest.state().loggedIn)).toBe(false);
  expect(await page.evaluate(() => realtimeTest.state().running)).toBeUndefined();
  await expect(page.locator('.bubble')).toHaveCount(0); await expect(page.locator('#auth-screen')).toBeVisible();
});
