import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { accountLines, deviceLines, deviceName, locationName, readableDate, PRIVACY_LINES } from '../cli/account-ui.mjs';
import { ChatApplication, COMMAND_ITEMS, HELP } from '../cli/application.mjs';
import { TerminalUI, safeText } from '../cli/terminal.mjs';
import { historyCommand } from '../cli/transcript.mjs';

function fixture({ loggedIn = true, started = true } = {}) {
  const input = new PassThrough(), output = new PassThrough(); let raw = '';
  input.isTTY = output.isTTY = true; input.setRawMode = () => {};
  output.columns = 96; output.rows = 24; output.on('data', (chunk) => { raw += chunk; });
  const ui = new TerminalUI({ input, output, color: 'always' }); ui.commands = COMMAND_ITEMS;
  const requests = [];
  const client = {
    server: 'https://example.test', user: loggedIn ? { id: 'alice', username: 'alice' } : null,
    selected: loggedIn ? { id: 'ab', peer: { id: 'bob', username: 'bob' } } : null,
    connected: true, ttl: '24h', messages: [], conversations: [], hasOlder: true,
    trust: () => ({ blocked: false, verified: true }),
    viewMessages() { return this.messages.filter((message) => message.expiresAt > Date.now()); },
    requireUser() { if (!this.user) throw new Error('请先登录。'); },
    async health() {}, async sync() {}, async logout() { this.user = null; this.selected = null; this.messages = []; },
    async request(path) { requests.push(path); return this.payload; },
    payload: { sessions: [{ current: true, device: 'CLI / Windows', method: 'cli' }], history: [] },
  };
  const app = new ChatApplication(client, ui);
  if (started) { ui.start(); app.render(); }
  return { app, client, ui, requests, raw: () => raw, close: () => { ui.stop(); app.transcript.clear(); } };
}
test('account text follows approved fields; device labels and untrusted terminal fields are sanitized', () => {
  const attack = '\x1b]52;c;Zm9v\x07\x1b[31m恶意\x1b[0m\n伪造';
  const lines = accountLines({ user: { username: attack }, server: 'https://example.test', version: '0.5.5', sessions: [{ current: true, method: 'cli', device: attack }] });
  assert.ok(lines.some((line) => line.includes('账号'))); assert.ok(lines.some((line) => line.includes('[本机]')));
  assert.ok(lines.some((line) => line.includes('客户端版本  0.5.5')));
  assert.ok(lines.every((line) => !line.includes('\x1b') && !line.includes('\n')));
  assert.equal(deviceName({ method: 'app', device: 'OPPO PKB110 / Android 15' }), 'OPPO Find X8');
  const devices = deviceLines({ history: [{ device: attack, method: 'toString', status: 'constructor', ip: attack, createdAt: 1800000000000, location: { region: attack } }] });
  assert.ok(devices.every((line) => !line.includes('\x1b') && !line.includes('\n')));
  assert.ok(devices.some((line) => line.includes('未知旧会话'))); assert.ok(!devices.join('\n').includes('function'));
  assert.equal(readableDate(undefined), '时间未知'); assert.equal(locationName(null), '无法确定');
  assert.equal(locationName({ country: 'CN', region: '北京', city: '北京' }), '中国 · 北京（估计）');
  assert.ok(PRIVACY_LINES.join('\n').includes('CLI 不领取或保存阅后图片'));
});
test('device history uses last ten successful logins, includes ended sessions, IP and estimated region', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ createdAt: 1800000000000 + i * 1000, device: 'device-' + i, method: 'cli', status: i === 11 ? 'logout' : 'active',
    endedAt: i === 11 ? 1800000015000 : null, ip: '192.0.2.' + i, location: { region: '上海' }, current: i === 10 }));
  const lines = deviceLines({ sessions: [{ device: 'not-history' }], history }); const text = lines.join('\n');
  assert.ok(text.startsWith('设备登录记录 · 最近 10 条')); assert.ok(text.includes('01. device-11 · CLI [已退出]'));
  assert.ok(text.includes('02. device-10 · CLI [已登录 · 本机]')); assert.ok(text.includes('退出时间'));
  assert.ok(text.includes('最近连接 IP   192.0.2.11')); assert.ok(text.includes('上海（估计）'));
  assert.ok(!text.includes('device-0 ')); assert.ok(!text.includes('device-1 ')); assert.ok(!text.includes('not-history'));
  assert.ok(deviceLines({ sessions: [] }).includes('目前没有登录记录。'));
});
test('account commands append privately without sending, maintain draft and reading anchor, and recall only valid commands', async () => {
  const f = fixture(), { app, client, ui, requests } = f;
  client.messages = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, seq: i + 1, own: true, text: '旧消息 ' + i, createdAt: Date.now(), expiresAt: Date.now() + 60000 }));
  client.payload.history = Array.from({ length: 10 }, (_, i) => ({ device: 'CLI / Windows', method: 'cli', createdAt: 1800000000000 - i * 1000, ip: '192.0.2.' + i, location: { country: 'CN' }, status: 'active' }));
  client.send = () => { throw new Error('account commands must never send'); };
  try {
    app.render(); ui.scrollBy(20); const anchor = { ...ui.anchor }, key = ui.state.historyKey;
    ui.key('未提交草稿', {}); const cursor = ui.cursor;
    await app.execute('/me'); await app.execute('/devices'); await app.execute('/privacy');
    assert.deepEqual(requests, ['/api/account/sessions', '/api/account/sessions']);
    assert.equal(ui.state.historyKey, key); assert.deepEqual(ui.anchor, anchor);
    assert.equal(ui.buffer, '未提交草稿'); assert.equal(ui.cursor, cursor); assert.equal(ui.state.canLoadOlder, true);
    assert.ok(ui.state.body.includes('  旧消息 0')); assert.equal(app.transcript.entries.length, 3);
    assert.ok(!JSON.stringify(app.transcript.entries).includes('旧消息'));
    assert.deepEqual(ui.commandHistory, ['/me', '/devices', '/privacy']);
    for (const name of ['/me', '/devices', '/privacy']) {
      assert.ok(COMMAND_ITEMS.some((item) => item.name === name)); assert.ok(HELP.some((line) => line.startsWith(name)));
      assert.equal(historyCommand(name, ''), name); assert.equal(historyCommand(name, 'password'), null);
      await app.execute(name + ' password');
    }
    assert.deepEqual(ui.commandHistory, ['/me', '/devices', '/privacy']); assert.ok(!f.raw().includes('password'));
    await app.execute('/logout'); assert.equal(app.transcript.entries.length, 0); assert.equal(ui.commandHistory.length, 0);
  } finally { f.close(); }
});
test('account read commands require login; privacy remains usable before login', async () => {
  const f = fixture({ loggedIn: false });
  try {
    await f.app.execute('/me'); await f.app.execute('/devices'); assert.equal(f.requests.length, 0);
    await f.app.execute('/privacy'); assert.ok(f.ui.state.body.includes('隐私与边界'));
  } finally { f.close(); }
});
test('startup restores protected login; quit suspends, explicit logout revokes, and old clients securely log out', async () => {
  const f = fixture({ loggedIn: false, started: false }); let restored = 0, suspended = 0, revoked = 0;
  f.client.restoreSavedLogin = async () => { restored++; f.client.user = { id: 'alice', username: 'alice' }; return true; };
  f.client.suspend = async () => { suspended++; };
  f.client.logout = async () => { revoked++; f.client.user = null; f.client.selected = null; };
  const running = f.app.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restored, 1); assert.ok(f.app.notice.includes('已恢复'));
  await f.app.execute('/logout'); assert.equal(revoked, 1);
  await f.app.close(); await running; assert.equal(suspended, 1); assert.equal(revoked, 1);
  const legacy = fixture(); let legacyRevocations = 0;
  legacy.client.logout = async () => { legacyRevocations++; };
  await legacy.app.close(); assert.equal(legacyRevocations, 1);
});
test('startup restore network failure stays visible and does not silently revoke saved login', async () => {
  const f = fixture({ loggedIn: false, started: false }); let revoked = 0;
  f.client.restoreSavedLogin = async () => { throw new Error('连接中断。'); };
  f.client.logout = async () => { revoked++; }; f.client.suspend = async () => {};
  const running = f.app.start(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ui.busy, false);
  assert.ok(f.app.notice.includes('受保护记录仍保留')); assert.equal(revoked, 0);
  await f.app.close(); await running; assert.equal(revoked, 0);
});
test('closing during saved-login restore waits before suspending unlocked memory', async () => {
  const f = fixture({ loggedIn: false, started: false }); let finishRestore, suspended = 0;
  f.client.restoreSavedLogin = async () => { await new Promise((resolve) => { finishRestore = resolve; }); f.client.user = { id: 'restored' }; return true; };
  f.client.suspend = async () => { suspended++; f.client.user = null; };
  const running = f.app.start(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ui.busy, true);
  const closing = f.app.close(); assert.equal(suspended, 0);
  finishRestore(); await closing; await running;
  assert.equal(suspended, 1); assert.equal(f.client.user, null); assert.equal(f.ui.active, false);
});
test('refresh can recover saved login after connectivity returns; server change clears old saved origin first', async () => {
  const f = fixture({ loggedIn: false }); const calls = [];
  f.client.health = async () => { calls.push('health:' + f.client.server); f.client.connected = true; };
  f.client.restoreSavedLogin = async () => { calls.push('restore'); f.client.user = { id: 'alice', username: 'alice' }; return true; };
  f.client.sync = async () => { calls.push('sync'); };
  f.client.logout = async () => { calls.push('logout:' + f.client.server); f.client.user = null; f.client.selected = null; };
  try {
    await f.app.execute('/refresh'); assert.deepEqual(calls, ['health:https://example.test', 'restore', 'sync']);
    assert.ok(f.app.notice.includes('已恢复'));
    f.client.user = null; calls.length = 0;
    await f.app.execute('/server https://new.example.test');
    assert.deepEqual(calls, ['logout:https://example.test', 'health:https://new.example.test']);
    assert.equal(f.client.server, 'https://new.example.test');
    calls.length = 0; await f.app.execute('/server https://user:password@invalid.test'); assert.deepEqual(calls, []);
  } finally { f.close(); }
});
