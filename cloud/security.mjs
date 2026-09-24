// Cloud authentication verifies a client-derived 256-bit credential, NOT a raw
// password. See cloud/AUTHENTICATION.md. No key can decrypt a user's vault here.
const enc = new TextEncoder();
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const USERNAME = /^[a-z0-9_]{3,24}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const randomB64 = (size) => toB64(crypto.getRandomValues(new Uint8Array(size)));
export const toB64 = (bytes) => btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join(''));
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))), (b) => b.toString(16).padStart(2,'0')).join('');
}
export async function mac(secret, ...values) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) fail(503, '云端认证尚未配置。');
  const raw = Uint8Array.from(secret.match(/../g), (s) => parseInt(s,16));
  const key = await crypto.subtle.importKey('raw', raw, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  raw.fill(0);
  return toB64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(JSON.stringify(values)))));
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d=0; for (let i=0;i<a.length;i++) d |= a.charCodeAt(i)^b.charCodeAt(i); return d===0;
}
export function validB64(value, min, max=min) {
  if (typeof value !== 'string' || value.length>Math.ceil(max/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400,'无效的加密数据。');
  let raw; try { raw=atob(value); } catch { fail(400,'无效的加密数据。'); }
  if (raw.length<min || raw.length>max || btoa(raw)!==value) fail(400,'无效的加密数据长度。');
}
export function sequence(value) {
  if (typeof value!=='string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400,'无效的消息游标。');
  return Number(value);
}
export function requestOrigin(request, env) {
  const u=new URL(request.url);
  const local=env.ENVIRONMENT==='test' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if (!local && (u.protocol!=='https:' || !(env.ALLOWED_ORIGINS || '').split(',').includes(u.origin))) fail(403,'不允许的访问地址。');
  return u.origin;
}
export function requireWrite(request, origin) {
  if (request.headers.get('Origin')!==origin || request.headers.get('X-Whisper-Request')!=='1') fail(403,'请求来源校验失败。');
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) fail(415,'需要 JSON 请求。');
}
export async function readJSON(request, limit) {
  if (Number(request.headers.get('Content-Length'))>limit) fail(413,'发送内容过大。');
  const reader=request.body?.getReader(); if (!reader) fail(400,'需要请求内容。');
  let size=0; const chunks=[];
  while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength;
    if(size>limit) { await reader.cancel(); fail(413,'发送内容过大。'); } chunks.push(value); }
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  let body; try { body=JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400,'无效的 JSON。'); }
  if (!body || Array.isArray(body) || typeof body!=='object') fail(400,'需要 JSON 对象。'); return body;
}
export const SECURITY_HEADERS = {
  'Cache-Control':'no-store, max-age=0', 'Pragma':'no-cache', 'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer', 'Cross-Origin-Resource-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
};
