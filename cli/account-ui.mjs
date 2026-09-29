import { safeText } from './theme.mjs';

const METHODS = Object.freeze({ web: '网页', app: 'Android App', cli: 'CLI', unknown: '未知旧会话' });
const STATES = Object.freeze({ active: '已登录', logout: '已退出', expired: '已过期', revoked: '已撤销' });
// API fields are terminal data, never formatting or additional command rows.
const field = (value) => typeof value === 'string' ? safeText(value).replace(/\n/g, ' ').trim() : '';
export function deviceName(session) {
  const value = field(session?.device) || '未知设备';
  const name = session?.method === 'app' ? value.split(/\s*\/\s*Android\b/i)[0] : value;
  return /^OPPO PKB110$/i.test(name) ? 'OPPO Find X8' : name;
}
export function readableDate(value) {
  const date = new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
export function locationName(value) {
  if (!value || typeof value !== 'object') return '无法确定';
  let country = field(value.country);
  if (/^[A-Z]{2}$/.test(country)) {
    try { country = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(country); } catch {}
  }
  const parts = [country, field(value.region), field(value.city)].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(' · ') + '（估计）' : '无法确定';
}
export function accountLines({ user, server, version, sessions = [] }) {
  const current = Array.isArray(sessions) ? sessions.find((session) => session?.current === true) : null;
  return ['我的', '', `账号        @${field(user?.username)}`, `当前设备    ${deviceName(current)}${current ? ' [本机]' : '（未返回当前设备记录）'}`,
    `当前服务    ${field(server)}`, `客户端版本  ${field(version)}`, '', '/devices 设备登录记录 · /passwd 修改密码 · /privacy 隐私与边界'];
}
export function deviceLines(payload = {}) {
  const source = Array.isArray(payload?.history) ? payload.history : Array.isArray(payload?.sessions) ? payload.sessions : [];
  const history = [...source].sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0)).slice(0, 10);
  const lines = [`设备登录记录 · 最近 ${history.length} 条`, ''];
  if (!history.length) lines.push('目前没有登录记录。');
  history.forEach((session, i) => {
    const method = Object.hasOwn(METHODS, session?.method) ? METHODS[session.method] : METHODS.unknown;
    const state = Object.hasOwn(STATES, session?.status) ? STATES[session.status] : method === METHODS.unknown ? '未知旧会话' : '已登录';
    const ip = field(session?.ip);
    lines.push(`${String(i + 1).padStart(2, '0')}. ${deviceName(session)} · ${method} [${state}${session?.current === true ? ' · 本机' : ''}]`,
      `    登录时间      ${readableDate(session?.createdAt)}`);
    if (session?.endedAt != null) lines.push(`    ${session.status === 'logout' ? '退出时间' : '失效时间'}      ${readableDate(session.endedAt)}`);
    lines.push(`    最近连接 IP   ${ip && !['unknown', 'local'].includes(ip) ? ip : '待该设备再次连接'}`,
      `    IP 地区       ${locationName(session?.location)}`, '');
  });
  lines.push('最多保留最近十次成功登录；退出后记录仍保留。', 'IP 为最近连接出口，地区是估计值；已登录不代表当前在线。', '滚轮 / PgUp / PgDn 翻阅；Ctrl+End 回到底部。');
  return lines;
}
export const PRIVACY_LINES = Object.freeze(['隐私与边界', '', '文字在设备上加解密，服务仍能看到 IP、时间和通信关系。',
  '此原型未经安全审计，无前向保密，不承诺匿名。', '删除和到期清理无法删除截图、录屏、终端录制或其他外部副本。',
  'CLI 不领取或保存阅后图片；使用 /web 到网页查看。', '网页登录和 CLI 的身份存储支持范围不同；以本机登录提示为准。']);
