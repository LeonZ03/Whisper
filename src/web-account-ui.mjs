import { createAccountSessionsUI } from './account-sessions-ui.mjs';

// Browser navigation only. Password and logout behavior remain with accountUI/app.
export function createWebAccountUI({ api, getSelf, onLeaveChat = () => {} } = {}) {
  if (typeof api !== 'function' || typeof getSelf !== 'function') throw new TypeError('account API and current user getter are required');
  const $ = id => document.getElementById(id);
  const screen = $('chat-screen'), content = $('web-content');
  if (!screen || !content) throw new TypeError('web account markup is required');
  // accountUI initially places its existing owner panel directly in the workspace.
  content.append($('admin-panel'));
  let view = 'conversations', chatFocus = null, chatSelection = null, readingPosition = null;
  const sessions = createAccountSessionsUI({ root: $('device-history-list'), summary: $('current-device-name'),
    fetchImpl: async (path, options) => {
      if (!getSelf() || options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const user = getSelf();
      const payload = await api(path);
      if (getSelf() !== user || options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return { ok: true, json: async () => payload };
    }
  });
  function captureChat() {
    if (!['conversations', 'chat'].includes(view)) return;
    const focused = document.activeElement;
    if ($('chat-body').contains(focused)) {
      chatFocus = focused;
      chatSelection = typeof focused.selectionStart === 'number' ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
    }
    readingPosition = $('messages').scrollTop;
  }
  function refreshProfile(user) {
    const username = typeof user?.username === 'string' ? user.username : '';
    const service = $('entry-kind').textContent || '当前服务';
    $('my-name').textContent = username;
    $('my-avatar').textContent = Array.from(username)[0]?.toUpperCase() || '';
    $('my-role').textContent = (service === '云端服务' ? '云端' : '本机') + (user?.role === 'root' ? '管理员' : '账号');
    $('my-service-kind').textContent = service;
    $('my-service-host').textContent = location.host;
    $('my-web-version').textContent = screen.querySelector('[data-app-version]')?.textContent || '版本未知';
    $('nav-conversations').querySelector('span').textContent = user?.role === 'root' ? '管理' : '会话';
  }
  function show(next) {
    const user = getSelf();
    if (!user) return;
    next = next === 'chat' ? 'conversations' : next;
    if (!['conversations', 'admin', 'my', 'devices'].includes(next)) return;
    if (next === 'conversations' && user.role === 'root') next = 'admin';
    if (next === 'admin' && user.role !== 'root') next = 'conversations';
    const prior = view;
    if (['my', 'devices'].includes(next) && ['conversations', 'chat'].includes(prior)) {
      captureChat(); onLeaveChat();
    }
    view = next; screen.dataset.webView = next;
    $('chat-body').hidden = next !== 'conversations';
    $('admin-panel').hidden = next !== 'admin';
    $('my-panel').hidden = next !== 'my';
    $('device-history-panel').hidden = next !== 'devices';
    for (const name of ['conversations', 'my']) {
      const active = name === 'my' ? ['my', 'devices'].includes(next) : ['conversations', 'admin'].includes(next);
      $(`nav-${name}`).setAttribute('aria-current', active ? 'page' : 'false');
    }
    if (next === 'my') {
      refreshProfile(user);
      if (prior === 'devices') $('account-devices-open').focus();
      else if (prior !== 'my') $('my-title').focus();
      if (prior !== 'devices') void sessions.load();
    } else if (next === 'devices') {
      if (prior !== 'devices') { $('device-history-scroll').scrollTop = 0; $('device-history-title').focus(); }
      void sessions.load();
    } else if (next === 'conversations' && ['my', 'devices'].includes(prior)) {
      if (readingPosition != null) $('messages').scrollTop = readingPosition;
      if (chatFocus?.isConnected && !chatFocus.closest('[hidden]')) {
        chatFocus.focus({ preventScroll: true });
        if (chatSelection) chatFocus.setSelectionRange(chatSelection.start, chatSelection.end, chatSelection.direction);
      }
    }
  }
  for (const id of ['nav-conversations', 'nav-my']) $(id).addEventListener('pointerdown', captureChat);
  $('nav-conversations').addEventListener('click', () => show('conversations'));
  $('nav-my').addEventListener('click', () => show('my'));
  $('account-devices-open').addEventListener('click', () => show('devices'));
  $('device-history-back').addEventListener('click', () => show('my'));
  $('privacy-button').addEventListener('click', () => { if (getSelf()) $('privacy-dialog').showModal(); });
  $('privacy-close').addEventListener('click', () => $('privacy-dialog').close());
  screen.addEventListener('keydown', event => {
    if (event.key === 'Escape' && view === 'devices' && !document.querySelector('dialog[open]')) {
      event.preventDefault(); show('my');
    }
  });
  return {
    enter(user) {
      sessions.clear(); chatFocus = null; chatSelection = null; readingPosition = null;
      refreshProfile(user);
      // Avoid moving focus behind the mandatory first-password dialog.
      view = user?.role === 'root' ? 'admin' : 'conversations'; show(view);
    },
    clear() {
      sessions.clear(); $('privacy-dialog').close();
      for (const id of ['my-name', 'my-avatar', 'my-role', 'my-service-host']) $(id).textContent = '';
      $('my-service-kind').textContent = '当前服务';
      $('my-panel').hidden = true; $('device-history-panel').hidden = true;
      view = 'conversations'; screen.dataset.webView = view;
      $('nav-conversations').querySelector('span').textContent = '会话';
      $('nav-conversations').setAttribute('aria-current', 'page'); $('nav-my').setAttribute('aria-current', 'false');
      chatFocus = null; chatSelection = null; readingPosition = null;
    },
    show,
    resume() { if (getSelf() && ['my', 'devices'].includes(view)) { refreshProfile(getSelf()); void sessions.load(); } }
  };
}
