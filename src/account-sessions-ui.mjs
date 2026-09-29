const METHOD_LABELS = { web: '网页', app: 'Android App', cli: 'CLI', unknown: '未知旧会话' };

function readableDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusNode(text, className = 'sessions-status') {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  return node;
}

export function createAccountSessionsUI({ root, fetchImpl = fetch } = {}) {
  if (!root) throw new TypeError('account sessions root is required');
  let controller = null;
  const render = (sessions = []) => {
    root.replaceChildren();
    if (!Array.isArray(sessions) || sessions.length === 0) {
      root.append(statusNode('目前没有已登录设备。'));
      return;
    }
    const list = document.createElement('ul');
    list.className = 'session-list';
    for (const session of sessions) {
      const item = document.createElement('li');
      item.className = 'session-item';
      const heading = document.createElement('div');
      heading.className = 'session-heading';
      const name = document.createElement('strong');
      const method = METHOD_LABELS[session?.method] || METHOD_LABELS.unknown;
      name.textContent = typeof session?.device === 'string' && session.device.trim() ? session.device : method;
      heading.append(name);
      const state = document.createElement('span');
      state.className = session?.current === true ? 'session-current' : 'session-state';
      state.textContent = session?.current === true ? '本机' : method === METHOD_LABELS.unknown ? '未知旧会话' : '已登录';
      heading.append(state);
      const details = document.createElement('p');
      details.className = 'session-details';
      const ip = typeof session?.ip === 'string' && session.ip.trim() ? session.ip : '未知';
      details.textContent = `${method} · ${readableDate(session?.createdAt)} · IP ${ip}`;
      item.append(heading, details);
      list.append(item);
    }
    root.append(list);
  };
  const clear = () => {
    controller?.abort();
    controller = null;
    root.replaceChildren();
  };
  const load = async () => {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    root.replaceChildren(statusNode('正在读取设备…'));
    try {
      const response = await fetchImpl('/api/account/sessions', { method: 'GET', signal: requestController.signal });
      if (!response.ok) throw new Error('sessions request failed');
      const payload = await response.json();
      if (controller === requestController && !requestController.signal.aborted) render(payload?.sessions);
    } catch (error) {
      if (error?.name !== 'AbortError' && controller === requestController && !requestController.signal.aborted) {
        root.replaceChildren(statusNode('暂时无法读取已登录设备。'));
      }
    }
  };
  return { load, render, clear };
}
