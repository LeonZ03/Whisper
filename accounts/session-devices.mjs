// These labels describe the client. They never grant authentication or authorization.
export const APP_SESSION_EXPIRES_AT = 253402300799000; // 9999-12-31; explicit revocation still applies.
export const APP_COOKIE_MAX_AGE = 2147483647;
const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 128);
export function sessionDevice(request) {
  const marked = request.headers.get('X-Whisper-Client');
  const method = marked === 'app' || marked === 'cli' ? marked : 'web';
  const supplied = clean(request.headers.get('X-Whisper-Device'));
  if (method !== 'web') return { method, device: supplied || (method === 'app' ? 'Android App' : 'CLI') };
  const ua = clean(request.headers.get('User-Agent'));
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { method, device: os ? `${browser} / ${os}` : browser };
}
