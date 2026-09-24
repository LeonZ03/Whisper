import { b64, wipe, deriveCredentials } from './crypto.mjs';
import { preparePasswordChange } from './account-client.mjs';
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
export function accountUI({ api, getSelf, lock, toast }) {
  let action = null, nextLog = null, nextMember = null, busy = false;
  $('chat-screen').append($('admin-panel'));
  const clearSecrets = () => { for (const id of ['old-password','new-password','repeat-password','admin-password','recovery-result']) $(id).value = ''; };
  function openPassword() {
    if (!getSelf()) return;
    clearSecrets(); $('password-error').textContent = '';
    $('password-explanation').textContent = getSelf().mustChangePassword ? '首次登录或所有者恢复后，必须先修改初始密码才能管理站点。' : '只重新加密相同身份私钥，安全码和旧聊天不变。修改后所有设备需要重新登录。';
    $('password-close').hidden = Boolean(getSelf().mustChangePassword);
    $('password-dialog').showModal(); $('old-password').focus();
  }
  $('account-settings').onclick = openPassword;
  $('password-close').onclick = () => { $('password-dialog').close(); clearSecrets(); };
  $('password-dialog').addEventListener('cancel', e => { if (getSelf()?.mustChangePassword) e.preventDefault(); else clearSecrets(); });
  $('password-form').onsubmit = async event => {
    event.preventDefault(); if (busy || !getSelf()) return;
    if ($('new-password').value !== $('repeat-password').value) { $('password-error').textContent = '两次新密码不一致。'; return; }
    busy = true; $('password-submit').disabled = true; const user = getSelf();
    try {
      const me = await api('/api/account/me');
      if (getSelf() !== user || me.publicKey !== user.publicKey) throw Error('账号身份已变化，请重新登录。');
      const payload = await preparePasswordChange(me, $('old-password').value, $('new-password').value);
      payload.activationCode = user.activationCode || '';
      await api('/api/account/password','POST',payload); lock(); toast('密码已修改，身份密钥保持不变，请重新登录。');
    } catch (error) { $('password-error').textContent = error.message; }
    finally { clearSecrets(); busy = false; $('password-submit').disabled = false; }
  };
  function choose(target, kind) {
    action = { target, kind }; $('member-confirm-name').value = ''; $('admin-password').value = '';
    const labels = { approve: '批准申请', reject: '拒绝申请', remove: '删除成员', reset: '帮助成员重置密码' };
    $('member-action-title').textContent = `${labels[kind]} · ${target.username}`;
    $('member-action-description').textContent = kind === 'reset' ? '先撤销该成员登录，并生成一次恢复码。成员使用后会创建新身份、封存旧会话；旧私钥无法恢复。' : kind === 'remove' ? '立即禁止该成员登录和聊天，封存相关会话。账号名保留为不可复用的身份记录；旧密文按原期限清理，不代表物理擦除。' : '申请说明仅用于审批，不是端到端加密聊天。请确认你认识申请人。';
    $('member-action-error').textContent = ''; $('member-action-dialog').showModal();
  }
  async function members(more = false) {
    const user = getSelf(); if (user?.role !== 'root' || user.mustChangePassword) return;
    const result = await api('/api/admin/members' + (more && nextMember ? '?before=' + nextMember : '')); if (getSelf() !== user) return;
    const fragment = document.createDocumentFragment();
    const statuses = { pending: '等待审批', active: '已批准', recovery: '等待成员恢复' };
    for (const member of result.members) {
      const card = node('article', '', 'member-card'); card.dataset.memberId = member.id;
      const info = node('div', '', 'member-info'); info.append(node('strong', member.username), node('span', member.role === 'root' ? '管理员' : statuses[member.status] || member.status, 'member-status'));
      if (member.applicationMessage) info.append(node('p', member.applicationMessage, 'application-message'));
      info.append(node('small', '申请 / 创建时间：' + new Date(member.createdAt).toLocaleString())); card.append(info);
      if (member.role !== 'root') {
        const actions = node('div', '', 'member-actions');
        const choices = member.status === 'pending' ? [['approve','批准'],['reject','拒绝']] : [['reset','帮助改密'],['remove','删除成员']];
        for (const [kind,label] of choices) { const button = node('button', label, 'quiet'); button.dataset.action = kind; button.onclick = () => choose(member, kind); actions.append(button); }
        card.append(actions);
      }
      fragment.append(card);
    }
    if (more) $('member-list').append(fragment); else $('member-list').replaceChildren(fragment);
    nextMember = result.next; $('member-more').hidden = !nextMember;
  }
  $('admin-refresh').onclick = () => { void members().catch(e => toast(e.message)); };
  $('member-more').onclick = () => { void members(true).catch(e => toast(e.message)); };
  $('member-action-close').onclick = () => { action = null; clearSecrets(); $('member-action-dialog').close(); };
  $('member-action-dialog').addEventListener('cancel', () => { action = null; clearSecrets(); });
  $('member-action-form').onsubmit = async event => {
    event.preventDefault(); if (!action || busy || !getSelf()) return;
    const user = getSelf(), selected = action; let credentials;
    busy = true; $('member-action-submit').disabled = true;
    try {
      const me = await api('/api/account/me'); if (getSelf() !== user || me.role !== 'root') return;
      credentials = await deriveCredentials($('admin-password').value, me.salt);
      const result = await api(`/api/admin/members/${selected.target.id}/${selected.kind}`, 'POST', {
        currentAuthKey: b64(credentials.authKey), confirmUsername: $('member-confirm-name').value,
        credentialVersion: selected.target.credentialVersion
      });
      if (getSelf() !== user) return;
      $('member-action-dialog').close(); action = null; toast(result.message || '操作已完成。');
      if (result.recoveryCode) { $('recovery-result').value = result.recoveryCode; $('recovery-result-dialog').showModal(); }
      await members();
    } catch (error) { $('member-action-error').textContent = error.message; }
    finally { $('admin-password').value = ''; wipe(credentials?.authKey); wipe(credentials?.vaultKey); busy = false; $('member-action-submit').disabled = false; }
  };
  $('recovery-result-close').onclick = () => { $('recovery-result').value = ''; $('recovery-result-dialog').close(); };
  $('recovery-result-dialog').addEventListener('cancel', () => { $('recovery-result').value = ''; });
  async function logs(more = false) {
    const user = getSelf(); if (user?.role !== 'root' || user.mustChangePassword) return;
    const result = await api('/api/admin/logins' + (more && nextLog ? '?before=' + nextLog : ''));
    if (getSelf() !== user) return;
    if (!more) $('login-records').replaceChildren();
    const labels = { success: '成功', success_initial: '初始登录成功', failed: '失败', locked: '暂时锁定', reauth_failed: '敏感操作确认失败', state_changed: '状态已变化' };
    for (const record of result.rows) {
      const tr = document.createElement('tr');
      const date = node('td', new Date(record.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
      date.title = `${new Date(record.timestamp).toISOString()} · ${record.timestamp}`;
      const geo = record.location || {};
      const location = [geo.country, geo.region, geo.city].filter(Boolean).join(' / ') || '无法确定';
      const estimate = node('td', location + (geo.postalCode ? `（邮区 ${geo.postalCode}）` : '') + ' · 估计');
      estimate.title = geo.source || 'IP 位置不代表真实住址；代理可能显示代理出口。';
      tr.append(date, node('td', labels[record.result] || record.result), node('td', record.ip), estimate); $('login-records').append(tr);
    }
    nextLog = result.next; $('log-more').hidden = !nextLog;
  }
  $('log-refresh').onclick = () => { void logs().catch(e => toast(e.message)); };
  $('log-more').onclick = () => { void logs(true).catch(e => toast(e.message)); };
  return {
    async enter(user) {
      $('chat-body').hidden = user.role === 'root'; $('admin-panel').hidden = user.role !== 'root';
      if (user.mustChangePassword) openPassword();
      else if (user.role === 'root') await Promise.all([members(), logs()]);
    },
    clear() {
      action = null; nextLog = null; nextMember = null; clearSecrets();
      for (const id of ['password-dialog','member-action-dialog','recovery-result-dialog']) $(id).close();
      $('member-list').replaceChildren(); $('login-records').replaceChildren(); $('admin-panel').hidden = true;
      $('chat-body').hidden = false;
    }
  };
}
