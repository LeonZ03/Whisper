import { fail, USERNAME, UUID, randomB64, digest, mac, equal, validB64, SECURITY_HEADERS } from '../cloud/security.mjs';
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...headers } });
const tokenOf = request => /(?:^|;\s*)whisper_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('Cookie') || '')?.[1];
const cookie = (value, origin, age = 43200) => `whisper_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
const viewUser = u => ({ id: u.id, username: u.username, publicKey: u.public_key, role: u.role, status: u.status, mustChangePassword: Boolean(u.must_change), credentialVersion: u.credential_version });
const vaultUser = u => ({ ...viewUser(u), salt: u.salt, vault: { nonce: u.vault_nonce, ciphertext: u.vault_cipher } });
function checkEnvelope(body) {
  validB64(body.authKey, 32); validB64(body.salt, 16); validB64(body.publicKey, 32);
  validB64(body.vault?.nonce, 24); validB64(body.vault?.ciphertext, 48);
  if (!Number.isInteger(body.passwordLength) || body.passwordLength < 1 || body.passwordLength > 12) fail(400, '新密码必须为 1–12 个字符，请更新客户端。');
}
export function accountService({ db, request, origin, body = {}, pepper, hashCredential, scheme = 'client-pbkdf2-hkdf+hmac-v1', location = {}, ip = 'unknown' }) {
  const stmt = (sql, ...args) => db.prepare(sql).bind(...args);
  const first = (sql, ...args) => stmt(sql, ...args).first();
  const all = async (sql, ...args) => (await stmt(sql, ...args).all()).results;
  const verifier = hashCredential || ((key, salt, username) => mac(pepper, 'auth-v1', username, salt, key));
  const attemptScope = async username => digest('account-login:' + username);
  const audit = (action, user = {}) => stmt('INSERT INTO admin_audit(timestamp,action,target_id,target_name) VALUES(?,?,?,?)', Date.now(), action, user.id || null, user.username || null);
  async function rootLog(result) {
    await stmt('INSERT INTO root_login_log(timestamp,result,ip,location) VALUES(?,?,?,?)', Date.now(), result, String(ip).slice(0, 80), JSON.stringify(location)).run();
  }
  async function failed(username) {
    await stmt('INSERT INTO auth_failures VALUES(?,1,?) ON CONFLICT(scope) DO UPDATE SET failures=CASE WHEN until_at<? THEN 1 ELSE failures+1 END,until_at=CASE WHEN until_at<? THEN excluded.until_at ELSE until_at END', await attemptScope(username), Date.now() + 900000, Date.now(), Date.now()).run();
  }
  async function checkAttempts(username) {
    const row = await first('SELECT failures FROM auth_failures WHERE scope=? AND until_at>?', await attemptScope(username), Date.now());
    if (row?.failures >= 5) fail(429, '此账号尝试过多，请 15 分钟后再试。');
  }
  async function verifyCredential(user, key, activationCode = '') {
    validB64(key, 32);
    if (!user) return false;
    if (user.auth_scheme === 'root-bootstrap-hmac-v1') {
      if (user.role !== 'root' || !user.must_change || !/^[a-f0-9]{64}$/.test(activationCode)) return false;
      return equal(await mac(activationCode, 'auth-v1', user.username, user.auth_salt, key), user.auth_hash);
    }
    return equal(await verifier(key, user.auth_salt, user.username), user.auth_hash);
  }
  async function authorize({ allowForced = false, memberOnly = false } = {}) {
    const token = tokenOf(request);
    const user = token && await first('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.credential_version=u.credential_version AND u.status=\'active\'', await digest(token), Date.now());
    if (!user) fail(401, '登录已失效，请重新登录。');
    if (user.must_change && !allowForced) fail(403, '请先修改初始密码，再使用其他功能。');
    if (memberOnly && user.role !== 'member') fail(403, 'root 仅用于管理，不参与成员聊天。');
    return user;
  }
  async function issue(user) {
    const token = randomB64(32).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const tokenHash = await digest(token);
    const insert = stmt("INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) SELECT ?,id,?,?,credential_version FROM users WHERE id=? AND credential_version=? AND auth_hash=? AND status='active' AND (auth_scheme<>'root-bootstrap-hmac-v1' OR root_activation_consumed=0) RETURNING user_id", tokenHash, Date.now(), Date.now() + 43200000, user.id, user.credential_version, user.auth_hash);
    let result;
    if (user.role === 'root') {
      const committed = await db.batch([
        insert,
        stmt('INSERT INTO root_login_log(timestamp,result,ip,location) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)', Date.now(), user.must_change ? 'success_initial' : 'success', String(ip).slice(0, 80), JSON.stringify(location), tokenHash),
        stmt('DELETE FROM auth_failures WHERE scope=?', await attemptScope(user.username))
      ]);
      result = committed[0].results?.[0];
    } else result = await insert.first();
    if (!result) fail(409, user.role === 'root' && user.auth_scheme === 'root-bootstrap-hmac-v1' ? '首次激活码已使用；请使用现有会话改密，或由所有者执行恢复。' : '账号状态已更新，请重新登录。');
    return { 'Set-Cookie': cookie(token, origin) };
  }
  async function reauthenticate(user, key, activationCode) {
    await checkAttempts(user.username);
    if (!(await verifyCredential(user, key, activationCode))) {
      await failed(user.username); if (user.role === 'root') await rootLog('reauth_failed');
      fail(403, '当前密码不正确。');
    }
  }
  async function handle(path, method) {
    if (path === '/api/auth/salt' && method === 'GET') {
      const username = (new URL(request.url).searchParams.get('username') || '').toLowerCase();
      if (!USERNAME.test(username)) fail(400, '用户名需为 3–24 位字母、数字或下划线。');
      const u = await first('SELECT salt,auth_scheme FROM users WHERE username=?', username);
      const fake = await mac(pepper, 'fake-salt-v1', username);
      return json({ salt: u?.salt || btoa(atob(fake).slice(0, 16)), iterations: 600000, activationRequired: username === 'root' && u?.auth_scheme === 'root-bootstrap-hmac-v1' });
    }
    if (path === '/api/auth/register' && method === 'POST') {
      if (typeof body.username !== 'string' || !USERNAME.test(body.username) || body.username === 'root') fail(400, '用户名无效，root 是保留的管理员账号。');
      if (Object.keys(body).some(k => ['role', 'status', 'approved', 'mustChangePassword'].includes(k))) fail(400, '不能指定账号权限或审批状态。');
      if (typeof (body.applicationMessage ?? '') !== 'string' || (body.applicationMessage || '').length > 500) fail(400, '申请说明最多 500 字符。');
      checkEnvelope(body); const id = crypto.randomUUID(), authSalt = randomB64(16);
      const value = await verifier(body.authKey, authSalt, body.username);
      try {
        await stmt('INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,auth_scheme,created_at,status,application_message) VALUES(?,?,?,?,?,?,?,?,?,?,\'pending\',?)', id, body.username, body.publicKey, body.salt, body.vault.nonce, body.vault.ciphertext, authSalt, value, scheme, Date.now(), body.applicationMessage || '').run();
      } catch (error) {
        if (String(error).includes('UNIQUE')) fail(409, '用户名已被使用或已在申请中。');
        if (String(error).includes('USER_CAP')) fail(403, '申请及成员数量已达到实验站上限，请联系管理员。');
        throw error;
      }
      return json({ pending: true, message: '申请已提交，请等待管理员审批后登录。' }, 202);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = tokenOf(request);
      if (token) await stmt('DELETE FROM sessions WHERE token_hash=?', await digest(token)).run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', origin, 0) });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const username = typeof body.username === 'string' ? body.username : '';
      if (!USERNAME.test(username)) fail(401, '用户名或密码不正确。');
      let u;
      try {
        await checkAttempts(username);
        u = await first('SELECT * FROM users WHERE username=?', username);
        if (!(await verifyCredential(u, body.authKey, body.activationCode))) { await failed(username); fail(401, '用户名、密码或首次激活码不正确。'); }
        if (u.status === 'pending') fail(403, '申请仍在等待管理员审批。');
        if (u.status === 'recovery') fail(403, '管理员已发起重置，请使用恢复码设置新密码。');
        if (u.status !== 'active') fail(403, '账号当前不可用。');
      } catch (error) {
        if (username === 'root') await rootLog(error.status === 429 ? 'locked' : 'failed');
        throw error;
      }
      let headers;
      try { headers = await issue(u); }
      catch (error) { if (u.role === 'root' && error.status === 409) await rootLog('state_changed'); throw error; }
      if (u.role !== 'root') await stmt('DELETE FROM auth_failures WHERE scope=?', await attemptScope(username)).run();
      return json(vaultUser(u), 200, headers);
    }
    if (path === '/api/account/me' && method === 'GET') return json(vaultUser(await authorize({ allowForced: true })));
    if (path === '/api/account/password' && method === 'POST') {
      const u = await authorize({ allowForced: true });
      await reauthenticate(u, body.currentAuthKey, body.activationCode); checkEnvelope(body);
      if (body.publicKey !== u.public_key || body.credentialVersion !== u.credential_version) fail(409, '身份或密码版本已改变，请重新登录。');
      const authSalt = randomB64(16), value = await verifier(body.authKey, authSalt, u.username);
      const updated = await first('UPDATE users SET salt=?,vault_nonce=?,vault_cipher=?,auth_salt=?,auth_hash=?,auth_scheme=?,must_change=0,credential_version=credential_version+1 WHERE id=? AND credential_version=? AND auth_hash=? AND status=\'active\' RETURNING id', body.salt, body.vault.nonce, body.vault.ciphertext, authSalt, value, scheme, u.id, u.credential_version, u.auth_hash);
      if (!updated) fail(409, '密码已被其他请求修改，请重新登录。');
      await audit('password_changed', u).run();
      return json({ ok: true, reauthenticate: true, identityPreserved: true }, 200, { 'Set-Cookie': cookie('', origin, 0) });
    }
    if (path === '/api/auth/recover' && method === 'POST') {
      if (!USERNAME.test(body.username || '') || body.username === 'root' || !/^WR-[A-Za-z0-9_-]{43}$/.test(body.recoveryCode || '')) fail(400, '成员用户名或恢复码无效。root 请使用所有者恢复工具。');
      checkEnvelope(body);
      const hash = await digest(body.recoveryCode);
      const u = await first('SELECT u.* FROM account_resets r JOIN users u ON u.id=r.user_id WHERE u.username=? AND u.role=\'member\' AND u.status=\'recovery\' AND r.token_hash=? AND r.expires_at>? AND r.used_at IS NULL AND r.version=u.credential_version', body.username, hash, Date.now());
      if (!u) fail(403, '恢复码不正确、已使用或已过期。');
      if (body.publicKey === u.public_key) fail(400, '忘密重置必须创建新身份。');
      const salt = randomB64(16), value = await verifier(body.authKey, salt, u.username);
      const guard = 'EXISTS (SELECT 1 FROM users u WHERE u.id=? AND u.credential_version=? AND u.auth_hash=?)';
      const params = [u.id, u.credential_version + 1, value];
      // One atomic batch: rotate this member's identity and seal old conversations.
      // No old ciphertext is copied, decrypted or physically erased by recovery.
      const result = await db.batch([
        stmt('UPDATE users SET public_key=?,salt=?,vault_nonce=?,vault_cipher=?,auth_salt=?,auth_hash=?,auth_scheme=?,status=\'active\',must_change=0,credential_version=credential_version+1 WHERE id=? AND credential_version=? AND status=\'recovery\' AND EXISTS(SELECT 1 FROM account_resets WHERE user_id=? AND token_hash=? AND expires_at>? AND used_at IS NULL) RETURNING id', body.publicKey, body.salt, body.vault.nonce, body.vault.ciphertext, salt, value, scheme, u.id, u.credential_version, u.id, hash, Date.now()),
        stmt('UPDATE conversations SET archived_at=? WHERE (a=? OR b=?) AND ' + guard, Date.now(), u.id, u.id, ...params),
        stmt('UPDATE account_resets SET used_at=? WHERE user_id=? AND ' + guard, Date.now(), u.id, ...params)
      ]);
      if (!result[0].results?.length) fail(409, '恢复状态已变化，此次重置未执行。');
      await audit('identity_reset_completed', u).run();
      return json({ ok: true, message: '已设置新密码和新身份；旧会话已封存，不能恢复旧私钥，请重新核对安全码。' });
    }
    if (!path.startsWith('/api/admin/')) {
      if (path.startsWith('/api/auth/') || path.startsWith('/api/account/')) fail(404, '接口不存在。');
      return undefined;
    }
    const root = await authorize();
    if (root.role !== 'root' || root.username !== 'root') fail(403, '仅管理员可访问。');
    if (path === '/api/admin/members' && method === 'GET') {
      const raw = new URL(request.url).searchParams.get('before');
      const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
      if (!Number.isSafeInteger(before) || before < 1) fail(400, '无效的成员游标。');
      const rows = await all('SELECT rowid AS cursor,id,username,role,status,created_at AS createdAt,reviewed_at AS reviewedAt,application_message AS applicationMessage,credential_version AS credentialVersion FROM users WHERE status<>\'deleted\' AND rowid<? ORDER BY rowid DESC LIMIT 51', before);
      return json({ members: rows.slice(0, 50), next: rows.length > 50 ? rows[49].cursor : null });
    }
    if (path === '/api/admin/logins' && method === 'GET') {
      const raw = new URL(request.url).searchParams.get('before');
      const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
      if (!Number.isSafeInteger(before) || before < 1) fail(400, '无效的日志游标。');
      const rows = await all('SELECT * FROM root_login_log WHERE seq<? ORDER BY seq DESC LIMIT 101', before);
      return json({ rows: rows.slice(0, 100).map(row => ({ ...row, location: JSON.parse(row.location) })), next: rows.length > 100 ? rows[99].seq : null, note: 'IP 为网络出口，位置为估计；不代表实际住址。只记录本功能启用后到达应用的 root 登录尝试。' });
    }
    const match = /^\/api\/admin\/members\/([0-9a-f-]+)\/(approve|reject|remove|reset)$/.exec(path);
    if (method !== 'POST' || !match || !UUID.test(match[1])) fail(404, '接口不存在。');
    await reauthenticate(root, body.currentAuthKey);
    const target = await first('SELECT * FROM users WHERE id=? AND status<>\'deleted\'', match[1]);
    if (!target || target.role !== 'member') fail(403, '不能操作 root 或不存在的成员。');
    if (body.confirmUsername !== target.username || body.credentialVersion !== target.credential_version) fail(409, '成员信息已改变，或确认用户名不匹配。请刷新。');
    const action = match[2];
    if (action === 'approve') {
      const updated = await first('UPDATE users SET status=\'active\',reviewed_at=? WHERE id=? AND status=\'pending\' RETURNING id', Date.now(), target.id);
      if (!updated) fail(409, '此账号不在待审批状态。');
      await audit('approved', target).run(); return json({ ok: true });
    }
    if (action === 'reject' || action === 'remove') {
      if (action === 'reject' && target.status !== 'pending') fail(409, '只能拒绝待审批申请。');
      // Removal is an immediate access revocation, not a promise of physical erasure.
      // Keep an identity tombstone; ciphertext expires under its original lifetime.
      const result = await db.batch([
        stmt('UPDATE users SET status=\'deleted\',application_message=\'\',credential_version=credential_version+1 WHERE id=? AND role=\'member\' AND credential_version=? AND status' + (action === 'reject' ? '=\'pending\'' : '<>\'deleted\'') + ' RETURNING id', target.id, target.credential_version),
        stmt('UPDATE conversations SET archived_at=? WHERE (a=? OR b=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND status=\'deleted\')', Date.now(), target.id, target.id, target.id),
        stmt('UPDATE account_resets SET used_at=? WHERE user_id=?', Date.now(), target.id), audit(action, target)
      ]);
      if (!result[0].results?.length) fail(409, '成员状态已变化，请刷新。');
      return json({ ok: true, message: '成员已移除并撤销登录；旧会话封存，密文按原期限清理。' });
    }
    if (action === 'reset') {
      if (!['active', 'recovery'].includes(target.status)) fail(409, '只能帮助已批准的成员重置。');
      const code = 'WR-' + randomB64(32).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const expiresAt = Date.now() + 1800000, hash = await digest(code);
      const result = await db.batch([
        stmt('UPDATE users SET status=\'recovery\',credential_version=credential_version+1 WHERE id=? AND credential_version=? AND role=\'member\' RETURNING id', target.id, target.credential_version),
        stmt('INSERT INTO account_resets(user_id,token_hash,version,expires_at,created_by,used_at) SELECT id,?,credential_version,?,?,NULL FROM users WHERE id=? AND status=\'recovery\' AND credential_version=? ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,version=excluded.version,expires_at=excluded.expires_at,created_by=excluded.created_by,used_at=NULL', hash, expiresAt, root.id, target.id, target.credential_version + 1), audit('reset_issued', target)
      ]);
      if (!result[0].results?.length) fail(409, '成员状态已变化，请刷新。');
      return json({ ok: true, recoveryCode: code, expiresAt, message: '将恢复码私下交给成员。使用后创建新身份，旧会话不可再通过本站访问。' });
    }
    fail(404, '接口不存在。');
  }
  return { handle, authorize };
}
