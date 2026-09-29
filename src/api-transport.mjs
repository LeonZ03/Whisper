// Android uses a narrow native HTTPS transport. Browser requests keep
// their existing same-origin cookie and CSRF behavior.
export async function requestAPI(path, method = 'GET', body) {
  let response;
  try {
    if (globalThis.whisperAndroidRequest) {
      response = await globalThis.whisperAndroidRequest(path, method, body);
    } else {
      response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Whisper-Request': '1' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    }
  } catch {
    throw new Error(globalThis.whisperAndroidRequest ? '连接中断，请检查网络后重试。' : '连接中断。请确认本机服务与临时隧道仍在运行。');
  }
  const result = await response.json().catch(() => ({ error: '服务器返回了无效响应。' }));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) globalThis.whisperAndroidSessionRevoked?.();
    const error = new Error(result.error || '请求失败。'); error.status = response.status; throw error;
  }
  return result;
}
