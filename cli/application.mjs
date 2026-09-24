import { TTL, normalizeServer } from './client.mjs';
import { CommandTranscript, historyCommand } from './transcript.mjs';
export const HELP = [
  '命令 / Commands', '', '/login              登录已有账号（密码隐藏输入）', '/register           用邀请码创建账号',
  '/chats              会话列表；输入序号选择', '/chat 用户名        与这个用户聊天 / 切换会话',
  '/safety             查看并核对完整安全码', '/ttl 1m|1h|24h|7d   设置以后发送的文字保留时间',
  '/delete 消息序号    双方删除一条消息（需要确认）', '/clear              清空当前双方记录（需要确认）',
  '/refresh            重新同步', '/web                显示网页地址；图片请用网页',
  '/server HTTPS地址   未登录时切换服务', '/logout             退出账号并清理本机解锁密钥',
  '/quit               退出 CLI，不关闭网页服务', '',
  '输入 / 即显示命令；↑↓ 选择，Enter 确认，Tab 只补全。', '滚轮 / PageUp / PageDown 翻阅；Ctrl+End 回到底部。', '滚到顶部自动加载更早的未到期消息；Ctrl+Home 到已加载顶部。', '直接输入文字，Enter 发送；Ctrl+J 换行；Esc 收起菜单或返回。',
  '发送以 / 开头的文字时用 // 开头；括号粘贴按文字处理。', '↑↓ 切换本次会话的有效命令；密码和聊天正文不进入命令历史。',
];
export const COMMAND_ITEMS = [
  { name: '/login', description: '登录已有账号' },
  { name: '/register', description: '邀请注册新账号' },
  { name: '/chats', description: '查看会话列表' },
  { name: '/chat', description: '选择联系人：/chat 用户名', argument: true },
  { name: '/safety', description: '核对双方安全码' },
  { name: '/ttl', description: '保留时间：1m / 1h / 24h / 7d', argument: true },
  { name: '/delete', description: '双方删除：/delete 消息序号', argument: true },
  { name: '/clear', description: '清空当前双方记录（需确认）' },
  { name: '/refresh', description: '重新同步消息' },
  { name: '/web', description: '查看网页入口' },
  { name: '/server', description: '切换服务器：/server HTTPS地址', argument: true },
  { name: '/logout', description: '退出账号' },
  { name: '/help', description: '查看帮助' },
  { name: '/quit', description: '退出 CLI，不停止服务' },
];
export const COMMANDS = COMMAND_ITEMS.map((item) => item.name);
const WELCOME = ['  Whisper / terminal', '', '  私人双人会话，在终端里继续。', '', '  1  登录已有账号     /login', '  2  创建一个账号     /register', '', '  与网页共用账号、联系人和未到期消息。', '  输入 / 显示命令；↑↓ 选择，Enter 确认。', '', '  此原型未经审计，无前向保密。请勿发送敏感信息。', '  删除无法防止截屏、另存或终端录制。'];
export class ChatApplication {
  constructor(client, ui) {
    this.client = client; this.ui = ui; this.notice = '输入 /login 登录，或 /register 注册。';
    this.overlay = null; this.overlayKind = null; this.chatChoices = [];
    this.transcript = new CommandTranscript(); this.outputFocus = null;
    this.busy = false; this.closed = false; this.nextPoll = 0; this.failures = 0; this.syncing = null;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  set notice(value) { this._notice = String(value ?? ''); this.noticeRole = 'muted'; }
  get notice() { return this._notice; }
  notify(value, role = 'muted') { this.notice = value; this.noticeRole = role; }
  scope() { return JSON.stringify([this.client.server, this.client.user?.id || '', this.client.selected?.id || '']); }
  commandScope() { return JSON.stringify([this.client.server, this.client.user?.id || '']); }
  showOutput(command, lines, kind = 'info') {
    this.transcript.setIdentity(this.commandScope());
    this.outputFocus = this.transcript.show(this.scope(), this.client.messages.at(-1)?.seq || 0, command, lines);
    this.overlay = null; this.overlayKind = kind;
  }
  async start() {
    this.ui.on('line', (line, literal) => { if (!this.busy && !this.closed) this.operation = this.execute(line, literal); });
    this.ui.on('quit', () => { void this.close(); });
    this.ui.on('escape', () => { this.overlay = null; this.overlayKind = null; this.render(); });
    this.ui.commands = COMMAND_ITEMS;
    this.ui.on('history', () => { void this.loadPrevious(); });
    this.ui.start(); this.render(); this.interval = setInterval(() => { void this.tick(); }, 500);
    try { await this.client.health(); this.notify('服务已连接。输入 /login 或 /register。', 'success'); }
    catch { this.notify('服务未连接：先运行 start.cmd，或 /server 设置正确地址。', 'warning'); }
    this.render(); return this.done;
  }
  async loadPrevious() {
    if (this.closed || this.busy || this.syncing || this.overlay || !this.client.hasOlder) return;
    this.historyLoading = true;
    this.syncing = (async () => {
      try {
        const count = await this.client.loadOlder();
        this.notice = count ? `已加载 ${count} 条历史，继续向上翻阅。` : '已到达仍可读取的最早消息。';
      } catch (error) { this.notify(error.message, 'error'); }
      finally { this.historyLoading = false; }
    })();
    this.render();
    try { await this.syncing; } finally { this.syncing = null; this.render(); }
  }
  chatBody(c) {
    const cache = this.chatCache;
    if (cache?.messages === c.messages && cache.peer === c.selected.peer.id && Date.now() < cache.expires) return cache;
    const body = [], keys = [], styles = [], groups = [];
    for (const m of c.viewMessages()) {
      const time = new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
      const lines = [`${m.own ? '你' : '@' + c.selected.peer.username}  ${time}  #${m.seq}`, ...m.text.split('\n').map((line) => '  ' + line), ''];
      const start = body.length;
      lines.forEach((line, i) => {
        body.push(line); keys.push(`${m.id}:${i}`);
        styles.push({ role: i === 0 ? 'message' : 'normal', own: m.own, expiresAt: m.expiresAt, countdown: i === lines.length - 2 && !m.consumedAt });
      });
      groups.push({ seq: m.seq, body: body.slice(start), keys: keys.slice(start), styles: styles.slice(start) });
    }
    if (!body.length) { body.push('这里还没有消息。', '', '在下方输入文字，按 Enter 发送。'); body.forEach((_, i) => { keys.push('empty:' + i); styles.push({ role: 'ui' }); }); }
    this.chatCache = { messages: c.messages, peer: c.selected.peer.id, expires: Math.min(Infinity, ...c.messages.map((m) => m.expiresAt)), body, keys, styles, groups };
    return this.chatCache;
  }
  render() {
    if (this.closed) return; this.transcript.setIdentity(this.commandScope()); const c = this.client; let trust = { blocked: false, verified: false };
    try { trust = c.trust(); } catch (error) { trust.blocked = true; this.notify(error.message, 'error'); }
    const peer = c.selected ? ` → @${c.selected.peer.username}` : ' → 未选择联系人';
    const status = c.connected ? '已连接' : '离线 / 重连中', identity = c.user ? `@${c.user.username}${peer}` : '未登录';
    const security = trust.blocked ? '公钥变化，已阻止聊天' : trust.verified ? '已核对安全码' : '请用 /safety 核对安全码';
    let body = this.overlay, bodyKeys = [], bodyStyles = [], bodyKind = 'ui';
    if (this.overlay || !c.user || !c.selected || !c.connected || trust.blocked) { this.chatCache = null; this.transcript.cache = null; }
    if (!body) {
      if (!c.user) body = WELCOME;
      else if (!c.selected) body = ['开始聊天', '', '输入 /chat 对方完整用户名。', '输入 /chats 查看已有会话。', '', 'CLI 与网页可互发文字；阅后图片在网页查看。'];
      else if (!c.connected) body = ['连接中断；已隐藏聊天内容，正在退避重连。', '', '发送结果未知时先 /refresh 核对。'];
      else if (trust.blocked) body = ['对方身份公钥变化，已停止发送与解密。', '', '不要直接覆盖信任记录，请通过可信渠道确认。'];
      else {
        const chat = this.transcript.compose(this.chatBody(c), this.scope()); body = chat.body; bodyKeys = chat.keys; bodyStyles = chat.styles; bodyKind = 'chat';
      }
    }
    if (bodyKind === 'ui' && body.length) {
      bodyStyles = body.map((_, i) => ({ role: i === 0 ? 'title' : 'ui' }));
      bodyKeys = body.map((_, i) => 'screen:' + i);
      if (!this.overlay && !c.selected) {
        const combined = this.transcript.compose({ body, keys: bodyKeys, styles: bodyStyles }, this.scope());
        body = combined.body; bodyKeys = combined.keys; bodyStyles = combined.styles;
      }
    }
    this.ui.set({ header: [' Whisper CLI  /  双人加密聊天', ` ${c.server}`, ` ${identity}  ·  ${status}`, c.user ? ` ${security}  ·  保留 ${c.ttl}  ·  /help 帮助` : ' 本机加解密 · 不保存明文文件 · /help 帮助'], body, bodyKeys, bodyStyles, bodyKind,
      commandScope: this.commandScope(), focusKey: this.outputFocus,
      selfName: c.user?.username, connected: c.connected, securityRole: c.user ? (trust.blocked ? 'error' : trust.verified ? 'success' : 'warning') : null,
      historyKey: `${c.server}:${c.user?.id || ''}:${c.selected?.id || ''}:${c.connected}:${trust.blocked}:${this.overlay ? body[0] : 'chat'}`, startAtTop: Boolean(this.overlay),
      latestSeq: c.messages.at(-1)?.seq || 0, canLoadOlder: !this.overlay && c.hasOlder, historyLoading: this.historyLoading,
      notice: this.busy && !this.ui.pending ? '正在处理…' : this.notice,
      noticeRole: this.busy && !this.ui.pending ? 'accent' : this.noticeRole,
      hint: '↑↓ 历史命令 · / 菜单 · Enter 发送 · PgUp 翻阅 · Ctrl+End 底部', prompt: this.busy && !this.ui.pending ? '… ' : '› ' });
    this.outputFocus = null;
  }
  async tick() {
    if (this.closed) return; this.render();
    if (this.busy || this.syncing || !this.client.user || Date.now() < this.nextPoll) return;
    this.syncing = this.synchronize(); try { await this.syncing; } finally { this.syncing = null; } this.render();
  }
  async synchronize() {
    try {
      await this.client.sync(); this.failures = 0; this.nextPoll = Date.now() + (this.client.pollIntervalMs || 2000);
      if (this.notice.startsWith('连接中断')) this.notify('已重新连接。', 'success');
    } catch (error) {
      this.client.messages = []; this.client.historyComplete = false; this.client.hasOlder = false; this.client.connected = false; this.failures++;
      this.nextPoll = Date.now() + Math.min(15000, 2000 * 2 ** Math.min(this.failures, 3));
      this.notify(error.status === 401 ? '登录已过期，请 /login 重新登录。' : '连接中断，正在重试。/refresh 可手动同步。', 'warning');
      if (!this.client.user) { this.overlay = null; this.ui.buffer = ''; this.ui.cursor = 0; }
    }
  }
  async confirm(text) {
    this.notice = text; this.render();
    const pending = this.ui.ask('确认请输入 yes（其他输入取消）'); this.render(); const answer = await pending; return answer.trim().toLowerCase() === 'yes';
  }
  async authenticate(register) {
    if (this.client.user) throw new Error('请先 /logout，再切换账号。');
    this.overlay = [register ? '创建账号' : '登录已有账号', '', '与网页共用同一身份；密码只在本机用于派生密钥。', '不会把明文密码写入命令行参数、文件或输入历史。', '', 'Esc 取消；密码遗失无法找回。'];
    this.render(); const username = await this.ui.ask('用户名'); let password = '', repeat = '', invite = '';
    try {
      password = await this.ui.ask('密码', { secret: true });
      if (register) {
        repeat = await this.ui.ask('再次输入密码', { secret: true });
        if (password !== repeat) throw new Error('两次密码不一致。');
        repeat = ''; invite = await this.ui.ask('邀请码', { secret: true });
      }
      this.render(); await this.client.authenticate({ username, password, invite, register }); password = ''; invite = '';
      if (this.closed) return; await this.client.sync(); this.overlay = null; this.overlayKind = null;
      this.notify('已登录。用 /chat 用户名 开始聊天；/chats 查看会话。', 'success');
    } finally { password = ''; repeat = ''; invite = ''; }
  }
  async execute(line, literal = false) {
    this.busy = true; this.ui.busy = true;
    try {
      if (this.syncing) await this.syncing; if (this.closed) return;
      const trimmed = line.trim(); if (!trimmed) return;
      let text = line, isCommand = !literal && trimmed.startsWith('/');
      if (trimmed.startsWith('//') && !literal) { text = line.replace('//', '/'); isCommand = false; }
      if (!this.client.user && !isCommand && !literal && ['1', '2'].includes(trimmed)) { await this.authenticate(trimmed === '2'); return; }
      if (this.overlayKind === 'chats' && !literal && /^[1-9]\d*$/.test(trimmed)) {
        const chosen = this.chatChoices[Number(trimmed) - 1]; if (!chosen) throw new Error('请选择列表中的有效序号。');
        await this.client.chat(chosen.peer.username); this.overlay = null; this.overlayKind = null; return;
      }
      if (!isCommand) {
        this.overlay = null; this.overlayKind = null; await this.client.send(text);
        this.notify('已发送。消息在本机加密后上传。', 'success'); this.ui.scroll = 0; this.ui.anchor = null; await this.synchronize(); return;
      }
      const space = trimmed.search(/\s/), command = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase(), argument = space === -1 ? '' : trimmed.slice(space).trim();
      if (['/login', '/register', '/logout', '/help', '/chats', '/safety', '/clear', '/refresh', '/web', '/quit'].includes(command) && argument) throw new Error('此命令不接受参数；账号和密码请在交互提示中输入。');
      const recalled = historyCommand(command, argument);
      if (recalled) this.ui.rememberCommand(recalled);
      switch (command) {
        case '/login': await this.authenticate(false); break;
        case '/register': await this.authenticate(true); break;
        case '/help': this.showOutput('/help', HELP, 'help'); this.notice = '帮助已追加；向上翻仍可查看聊天，直接输入可继续发送。'; break;
        case '/chat':
          await this.client.chat(argument); this.overlay = null; this.overlayKind = null; this.ui.scroll = 0;
          this.notice = '直接输入文字即可聊天；首次请 /safety 核对安全码。'; break;
        case '/chats':
          this.client.requireUser(); await this.client.sync(); this.chatChoices = [...this.client.conversations]; this.overlayKind = 'chats';
          this.showOutput('/chats', ['会话列表', '', ...this.chatChoices.map((c, i) => `${i + 1}. @${c.peer.username}`), '', '输入序号进入；也可 /chat 用户名；Esc 取消选择。'], 'chats');
          this.notice = this.chatChoices.length ? '选择会话后，直接输入文字。' : '还没有会话；/chat 对方用户名。'; break;
        case '/safety': {
          this.client.requireChat(); await this.client.sync(); this.client.requireChat(); const key = this.client.selected.peer.publicKey, code = await this.client.safety();
          this.showOutput('/safety', ['双方安全码', '', ...code.match(/.{1,39}/g), '', '通过当面或其他可信渠道核对全部分组。', '首次自动记住公钥，不代表已经验证身份。'], 'safety');
          this.render(); if (this.client.trust().blocked) throw new Error('公钥变化，禁止标记已验证。');
          if (await this.confirm('仅在双方安全码完全一致时确认。')) { this.client.verify(key); this.notice = '已在 CLI 标记安全码核对通过。'; }
          else this.notice = '没有更改核对状态。'; this.overlay = null; break;
        }
        case '/ttl':
          if (!Object.hasOwn(TTL, argument)) throw new Error('用法：/ttl 1m、1h、24h 或 7d。');
          this.client.ttl = argument; this.notice = `后续文字保留 ${argument}；已有消息不变。`; break;
        case '/delete': {
          this.client.requireChat(); await this.client.sync();
          const message = this.client.messages.find((m) => String(m.seq) === argument.replace(/^#/, ''));
          if (!message) throw new Error('用法：/delete 消息序号；例如 /delete 12。');
          if (await this.confirm(`删除双方消息 #${message.seq}？无法删除截图或其他副本。`)) { await this.client.remove(message.id); await this.synchronize(); this.notice = '服务端已删除；正常对方客户端同步后清理。'; }
          else this.notice = '删除已取消。'; break;
        }
        case '/clear': {
          this.client.requireChat(); await this.client.sync(); this.client.requireChat();
          const id = this.client.selected.id, through = Math.max(0, ...this.client.messages.map((m) => m.seq));
          if (!through) { this.notice = '没有可清空的消息。'; break; }
          if (await this.confirm('清空当前双方已有消息？不会删除确认期间新收到的消息。')) { await this.client.clear(id, through); await this.synchronize(); this.notice = '已清空；无法删除截图、录屏或外部副本。'; }
          else this.notice = '清空已取消。'; break;
        }
        case '/refresh':
          if (this.client.user) await this.synchronize(); else await this.client.health();
          this.notice = this.client.connected ? '已重新同步。' : this.notice; break;
        case '/web': this.showOutput('/web', ['网页入口', '', this.client.server, '', '请自行在浏览器打开，使用相同账号登录。', 'CLI 不会自动打开附件、写入图片文件或领取阅后图片。'], 'web'); break;
        case '/server':
          if (this.client.user) throw new Error('切换服务前先 /logout。');
          this.client.server = normalizeServer(argument); this.client.cookie = ''; this.client.connected = false;
          await this.client.health(); this.notice = '服务已切换；请确认地址可信，再登录。'; break;
        case '/logout':
          await this.client.logout(); this.overlay = null; this.overlayKind = null; this.notice = '已退出账号并清理本机解锁密钥；网页服务仍运行。'; break;
        case '/quit': void this.close(); break;
        default: throw new Error('未知命令。输入 /help；发送 / 开头的文字请用 //。');
      }
    } catch (error) {
      if (!this.closed) { this.notify(error.message, error.name === 'AbortError' ? 'muted' : 'error'); if (error.name === 'AbortError' || !this.client.user) { this.overlay = null; this.overlayKind = null; } }
    } finally { line = ''; this.busy = false; this.ui.busy = false; this.nextPoll = Date.now() + (this.client.pollIntervalMs || 2000); this.render(); }
  }
  async close() {
    if (this.closed) return; this.closed = true; clearInterval(this.interval); this.chatCache = null; this.transcript.clear(); this.ui.stop();
    // Wait for an in-flight login before revoking its newly issued session.
    if (this.syncing) await this.syncing.catch(() => {});
    if (this.operation) await this.operation.catch(() => {});
    await this.client.logout().catch(() => {}); this.resolveDone();
  }
}
