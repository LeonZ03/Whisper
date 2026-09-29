const METHOD_LABELS = { web: '网页', app: 'Android App', cli: 'CLI', unknown: '未知旧会话' };
const STATES = { active: '已登录', logout: '已退出', expired: '已过期', revoked: '已撤销' };

function deviceName(session) {
  const value = typeof session?.device === 'string' && session.device.trim() ? session.device.trim() : '未知设备';
  const name = session?.method === 'app' ? value.split(/\s*\/\s*Android\b/i)[0] : value;
  return /^OPPO PKB110$/i.test(name) ? 'OPPO Find X8' : name;
}

function deviceIcon(method) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('session-icon');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', method === 'app' ? 'M7 2h10v20H7z M11 18h2' : 'M2 3h20v14H2z M8 21h8 M12 17v4');
  svg.append(path); return svg;
}

function locationName(value) {
  if (!value || typeof value !== 'object') return '无法确定';
  let country = typeof value.country === 'string' ? value.country : '';
  if (/^[A-Z]{2}$/.test(country)) {
    try { country = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(country); } catch {}
  }
  const parts = [country, value.region, value.city].filter(part => typeof part === 'string' && part.trim());
  return parts.length ? [...new Set(parts)].join(' · ') + '（估计）' : '无法确定';
}

function readableDate(value) {
  const date = new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusNode(text, className = 'sessions-status') {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  return node;
}

export function createAccountSessionsUI({ root, summary, fetchImpl = fetch } = {}) {
  if (!root) throw new TypeError('account sessions root is required');
  let controller = null;
  const render = (sessions = [], history = sessions) => {
    if (summary) summary.textContent = deviceName(Array.isArray(sessions) ? sessions.find(session => session?.current === true) : null);
    root.replaceChildren();
    if (!Array.isArray(history) || history.length === 0) {
      root.append(statusNode('目前没有登录记录。'));
      return;
    }
    const list = document.createElement('ul');
    list.className = 'session-list';
    for (const session of history.slice(0, 10)) {
      const item = document.createElement('li');
      item.className = 'session-item';
      const heading = document.createElement('div');
      heading.className = 'session-heading';
      const name = document.createElement('strong');
      const method = METHOD_LABELS[session?.method] || METHOD_LABELS.unknown;
      name.textContent = deviceName(session);
      heading.append(deviceIcon(session?.method), name);
      const state = document.createElement('span');
      state.className = session?.current === true ? 'session-current' : 'session-state';
      state.textContent = session?.current === true ? '本机' : method === METHOD_LABELS.unknown ? '未知旧会话' : STATES[session?.status] || '已登录';
      state.dataset.status = session?.status || 'active';
      heading.append(state);
      const platform = statusNode(method, 'session-platform');
      if (session?.method === 'app') {
        const os = typeof session.device === 'string' ? /\bAndroid\s+[\d.]+/i.exec(session.device)?.[0] : '';
        if (os) platform.textContent += ' · ' + os;
      }
      const details = document.createElement('dl');
      details.className = 'session-details';
      const ip = typeof session?.ip === 'string' && session.ip.trim() && !['unknown', 'local'].includes(session.ip) ? session.ip : '待该设备再次连接';
      const detail = (label, value) => {
        const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; details.append(dt, dd);
      };
      detail('登录时间', readableDate(session?.createdAt));
      if (session?.endedAt != null) detail(session.status === 'logout' ? '退出时间' : '失效时间', readableDate(session.endedAt));
      detail('最近连接 IP', ip); detail('IP 地区', locationName(session?.location));
      item.append(heading, platform, details);
      list.append(item);
    }
    root.append(list);
  };
  const clear = () => {
    controller?.abort();
    controller = null;
    root.replaceChildren();
    if (summary) summary.textContent = '当前设备';
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
      if (controller === requestController && !requestController.signal.aborted) render(payload?.sessions, payload?.history ?? payload?.sessions);
    } catch (error) {
      if (error?.name !== 'AbortError' && controller === requestController && !requestController.signal.aborted) {
        root.replaceChildren(statusNode('暂时无法读取已登录设备。'));
      }
    }
  };
  return { load, render, clear };
}
