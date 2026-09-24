import { fail, USERNAME, UUID, randomB64, digest, mac, equal, validB64, sequence, requestOrigin, requireWrite, readJSON, SECURITY_HEADERS } from './security.mjs';
import { serveClientArchive } from './downloads.mjs';
const DAY=86400000;
const publicUser=u=>({id:u.id,username:u.username,publicKey:u.public_key});
const vaultUser=u=>({...publicUser(u),salt:u.salt,vault:{nonce:u.vault_nonce,ciphertext:u.vault_cipher}});
const envelope=m=>({seq:m.seq,id:m.id,conversationId:m.conversation_id,senderId:m.sender_id,type:m.type,
  nonce:m.type==='text'?m.nonce:null,ciphertext:m.type==='text'?m.ciphertext:null,
  createdAt:m.created_at,expiresAt:m.expires_at,consumedAt:m.consumed_at});
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{...SECURITY_HEADERS,...headers}});
function cookieToken(request) { return /(?:^|;\s*)whisper_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('Cookie')||'')?.[1]; }
function cookie(value,origin,age=43200) { return `whisper_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.startsWith('https:')?'; Secure':''}`; }
async function limit(binding,key,env) {
  if (!binding) { if(env.ENVIRONMENT==='test')return; fail(503,'限流组件尚未配置。'); }
  if (!(await binding.limit({key})).success) fail(429,'操作太频繁，请稍后重试。');
}
async function api(request,env,origin) {
  if (!env.DB || !/^[a-f0-9]{64}$/.test(env.AUTH_PEPPER||'')) fail(503,'云端服务尚未配置完成。');
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if (path==='/api/health' && method==='GET') return json({ok:true,app:'Whisper',version:__APP_VERSION__,
    instance:env.INSTANCE_ID,environment:'cloud',commit:__COMMIT__,pollIntervalMs:5000,
    capabilities:['message-history-v1','cloud-d1-v1']});
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  await limit(env.API_LIMIT,await digest('api:'+ip),env);
  const db=env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
  const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
  const first=(sql,...args)=>stmt(sql,...args).first();
  const all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
  let body={}; if(!['GET','HEAD'].includes(method)) {
    requireWrite(request,origin); body=await readJSON(request, /^\/api\/conversations\/[^/]+\/messages$/.test(path)?1950000:8192);
  }
  async function issue(userId) {
    const token=randomB64(32).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    const old=cookieToken(request), commands=[];
    if(old) commands.push(stmt('DELETE FROM sessions WHERE token_hash=?',await digest(old)));
    commands.push(stmt('INSERT INTO sessions VALUES(?,?,?,?)',await digest(token),userId,Date.now(),Date.now()+43200000));
    await db.batch(commands); return {'Set-Cookie':cookie(token,origin)};
  }
  if(path.startsWith('/api/auth/')) {
    await limit(env.AUTH_LIMIT,await digest('auth-ip:'+ip),env);
    if(path==='/api/auth/salt' && method==='GET') {
      const username=(url.searchParams.get('username')||'').toLowerCase();
      if(!USERNAME.test(username)) fail(400,'用户名需为 3–24 位小写字母、数字或下划线。');
      const u=await first('SELECT salt FROM users WHERE username=?',username);
      const fake=await mac(env.AUTH_PEPPER,'fake-salt-v1',username);
      return json({salt:u?.salt||btoa(atob(fake).slice(0,16)),iterations:600000});
    }
    if(path==='/api/auth/logout' && method==='POST') {
      const token=cookieToken(request); if(token)await stmt('DELETE FROM sessions WHERE token_hash=?',await digest(token)).run();
      return json({ok:true},200,{'Set-Cookie':cookie('',origin,0)});
    }
    if(method==='POST' && ['/api/auth/login','/api/auth/register'].includes(path)) {
      const {username,authKey}=body;
      if(typeof username!=='string'||!USERNAME.test(username)) fail(400,'用户名需为 3–24 位小写字母、数字或下划线。');
      validB64(authKey,32);
      await limit(env.AUTH_LIMIT,await digest('auth-user:'+username),env);
      if(path.endsWith('/register')) {
        if(!env.INVITE_CODE || !equal(body.invite,env.INVITE_CODE)) fail(403,'邀请码不正确，请向网站所有者索取。');
        validB64(body.salt,16); validB64(body.publicKey,32); validB64(body.vault?.nonce,24); validB64(body.vault?.ciphertext,48);
        const id=crypto.randomUUID(),authSalt=randomB64(16);
        const verifier=await mac(env.AUTH_PEPPER,'auth-v1',username,authSalt,authKey);
        try { await stmt('INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,username,body.publicKey,body.salt,body.vault.nonce,body.vault.ciphertext,authSalt,verifier,Date.now()).run(); }
        catch(error) { if(String(error).includes('UNIQUE'))fail(409,'用户名已被使用。'); if(String(error).includes('USER_CAP'))fail(403,'此实验站最多允许 50 个账号。'); throw error; }
        const u=await first('SELECT * FROM users WHERE id=?',id); return json(vaultUser(u),201,await issue(id));
      }
      const u=await first('SELECT * FROM users WHERE username=?',username);
      const candidate=await mac(env.AUTH_PEPPER,'auth-v1',username,u?.auth_salt||'unknown',authKey);
      if(!u || !equal(candidate,u.auth_hash))fail(401,'用户名或密码不正确。');
      return json(vaultUser(u),200,await issue(u.id));
    }
    fail(404,'接口不存在。');
  }
  const token=cookieToken(request);
  const session=token?await first('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?',await digest(token),Date.now()):null;
  if(!session)fail(401,'登录已过期，请重新登录。');
  const userId=session.user_id;
  const conversation=async(id)=>{
    const c=await first('SELECT * FROM conversations WHERE id=? AND (a=? OR b=?)',id,userId,userId);
    if(!c)fail(404,'会话不存在或无权访问。'); return c;
  };
  const message=async(id)=>{
    const m=await first('SELECT m.* FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE m.id=? AND (c.a=? OR c.b=?) AND m.expires_at>?',id,userId,userId,Date.now());
    if(!m)fail(404,'消息已删除、已过期或无权访问。');return m;
  };
  if(path==='/api/conversations') {
    if(method==='GET') {
      const rows=await all('SELECT c.id,c.updated_at,u.id AS peer_id,u.username,u.public_key FROM conversations c JOIN users u ON u.id=CASE WHEN c.a=? THEN c.b ELSE c.a END WHERE c.a=? OR c.b=? ORDER BY c.updated_at DESC',userId,userId,userId);
      return json(rows.map(c=>({id:c.id,peer:{id:c.peer_id,username:c.username,publicKey:c.public_key},updatedAt:c.updated_at})));
    }
    if(method==='POST') {
      if(Object.keys(body).some(k=>k!=='username') || !USERNAME.test(body.username||''))fail(400,'仅支持指定一个用户名的双人会话。');
      const peer=await first('SELECT * FROM users WHERE username=?',body.username);
      if(!peer || peer.id===userId)fail(404,'未找到该用户，或不能与自己聊天。');
      const [a,b]=[userId,peer.id].sort(), now=Date.now();
      await stmt('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?)',crypto.randomUUID(),a,b,now,now).run();
      const c=await first('SELECT id FROM conversations WHERE a=? AND b=?',a,b);
      return json({id:c.id,peer:publicUser(peer),updatedAt:now});
    }
  }
  const cm=/^\/api\/conversations\/([^/]+)\/(messages|history|message-state|clear)$/.exec(path);
  if(cm) {
    const id=cm[1],action=cm[2]; await conversation(id);
    if(method==='GET' && action==='messages') {
      const rows=await all('SELECT * FROM messages WHERE conversation_id=? AND expires_at>? ORDER BY seq DESC LIMIT 200',id,Date.now());
      return json(rows.reverse().map(envelope));
    }
    if(method==='GET' && action==='history') {
      const before=sequence(url.searchParams.get('beforeSeq'));
      const rows=await all('SELECT * FROM messages WHERE conversation_id=? AND seq<? AND expires_at>? ORDER BY seq DESC LIMIT 201',id,before,Date.now());
      return json({messages:rows.slice(0,200).reverse().map(envelope),hasMore:rows.length>200});
    }
    if(method==='GET' && action==='message-state') {
      const from=sequence(url.searchParams.get('fromSeq')),through=sequence(url.searchParams.get('throughSeq'));
      if(through<from)fail(400,'无效的消息范围。');
      const rows=await all('SELECT id,seq,consumed_at,expires_at FROM messages WHERE conversation_id=? AND seq>=? AND seq<=? AND expires_at>? ORDER BY seq LIMIT 10000',id,from,through,Date.now());
      return json(rows.map(m=>({id:m.id,seq:m.seq,consumedAt:m.consumed_at,expiresAt:m.expires_at})));
    }
    if(method==='POST' && action==='clear') {
      if(!Number.isSafeInteger(body.throughSeq)||body.throughSeq<0)fail(400,'无效的清理范围。');
      await stmt('DELETE FROM messages WHERE conversation_id=? AND seq<=?',id,body.throughSeq).run();return json({ok:true});
    }
    if(method==='POST' && action==='messages') {
      await limit(env.SEND_LIMIT,'sender:'+userId,env);
      const {id:mid,type,nonce,ciphertext,expiresAt}=body,now=Date.now();
      if(typeof mid!=='string'||!UUID.test(mid)||!['text','image'].includes(type))fail(400,'无效的消息。');
      if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+7*DAY+60000)fail(400,'消息保留时间必须在 7 天以内。');
      if(type==='image' && expiresAt>now+DAY+60000)fail(400,'未查看图片最多保留 24 小时。');
      validB64(nonce,24); validB64(ciphertext,17,type==='image'?1420000:24000);
      const cmds=[stmt('INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',mid,id,userId,type,type==='text'?nonce:null,type==='text'?ciphertext:null,now,expiresAt)];
      if(type==='image')cmds.push(stmt('INSERT INTO image_payloads VALUES(?,?,?)',mid,nonce,ciphertext));
      try {await db.batch(cmds);} catch(error) {
        if(String(error).includes('UNIQUE'))fail(409,'消息已存在，不能重复发送。');
        if(String(error).includes('STORAGE_CAP'))fail(507,'云端实验站存储达到上限，请先清理。'); throw error;
      }
      return json({ok:true,id:mid},201);
    }
  }
  const mm=/^\/api\/messages\/([^/]+)(\/open)?$/.exec(path);
  if(mm) {
    const m=await message(mm[1]);
    if(!mm[2] && method==='DELETE') {await stmt('DELETE FROM messages WHERE id=?',m.id).run();return json({ok:true});}
    if(mm[2] && method==='POST') {
      if(m.type!=='image'||m.sender_id===userId)fail(403,'只有接收方可以打开阅后图片。');
      const payload=await first('DELETE FROM image_payloads WHERE message_id=? AND EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=image_payloads.message_id AND (c.a=? OR c.b=?) AND m.sender_id<>? AND m.expires_at>? AND m.consumed_at IS NULL) RETURNING nonce,ciphertext',m.id,userId,userId,userId,Date.now());
      if(!payload)fail(410,'图片已经被打开、过期或删除。');
      return json({...envelope(m),nonce:payload.nonce,ciphertext:payload.ciphertext});
    }
  }
  fail(404,'接口不存在。');
}
export default {
  async fetch(request,env) {
    try {
      const origin=requestOrigin(request,env),path=new URL(request.url).pathname;
      if(path.startsWith('/api/'))return await api(request,env,origin);
      if(path==='/downloads/whisper-cli-windows-x64.zip')return await serveClientArchive(request,env);
      if(!['GET','HEAD'].includes(request.method))fail(405,'请求方法不支持。');
      return await env.ASSETS.fetch(request);
    } catch(error) {
      const status=error.status||500;
      // Do not print request URLs, bodies, credentials, SQL values, or headers.
      return json({error:status>=500?'服务暂时不可用，请稍后重试。':error.message},status,status===429?{'Retry-After':'60'}:{});
    }
  },
  async scheduled(_event,env,ctx) {
    // All reads check expiry themselves; this is physical active-table cleanup.
    const cleanup=env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE expires_at<=?').bind(Date.now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now())
    ]);
    ctx.waitUntil(cleanup);
  }
};
