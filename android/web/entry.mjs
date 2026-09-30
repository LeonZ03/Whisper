// Installed before the shared client starts. The APK only loads packaged assets.
const pending = new Map();
let sequence = 0;
globalThis.whisperAndroidRequest = (path, method, body) => new Promise((resolve, reject) => {
  const id = String(++sequence);
  const timer = setTimeout(() => { pending.delete(id); reject(Error('请求超时')); }, 25_000);
  pending.set(id, { resolve, reject, timer });
  try { globalThis.WhisperNative.request(id, path, method, method === 'GET' ? '' : JSON.stringify(body ?? {})); }
  catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
});
globalThis.whisperAndroidResponse = (id, status, body) => {
  const task = pending.get(id); if (!task) return;
  pending.delete(id); clearTimeout(task.timer);
  if (!status) task.reject(Error('网络连接失败'));
  else task.resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) });
};
globalThis.whisperAndroidClearSession = () => {
  globalThis.WhisperNative.clearSession();
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('会话已锁定')); }
  pending.clear();
};
globalThis.whisperAndroidExit = () => globalThis.WhisperNative.exit();
globalThis.whisperAndroidSaveLogin = async identity => Boolean(await globalThis.WhisperNative.saveLogin(JSON.stringify(identity)));
globalThis.whisperAndroidRestoreLogin = async () => {
  const value = await globalThis.WhisperNative.restoreLogin(); return value ? JSON.parse(value) : null;
};
await import('../../src/app.mjs');
document.querySelector('#app-update')?.addEventListener('click', () => globalThis.WhisperNative.checkUpdate?.(true));
setTimeout(() => globalThis.WhisperNative.checkUpdate?.(false), 5000);
