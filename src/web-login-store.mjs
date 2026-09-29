// Only sealed identity material is stored. The browser owns the HttpOnly cookie.
// A non-exportable key in this origin's profile is not hardware isolation or XSS protection.
const DB_NAME = 'whisper-login-v1';
const encoder = new TextEncoder(), decoder = new TextDecoder();
export function createWebLoginStore() {
  let pending = Promise.resolve(), epoch = 0;
  const sequence = task => { const result = pending.then(task); pending = result.catch(() => {}); return result; };
  async function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('浏览器登录存储不可用。'));
      request.onblocked = () => reject(Error('浏览器登录存储被占用。'));
    });
  }
  async function transaction(mode, work) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('vault', mode), store = tx.objectStore('vault');
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(Error('浏览器登录存储不可用。'));
        work(store, value => { result = value; });
      });
    } finally { db.close(); }
  }
  const read = name => transaction('readonly', (store, done) => { store.get(name).onsuccess = event => done(event.target.result); });
  const aad = () => encoder.encode('whisper-login-v1:' + location.origin);
  async function key() {
    const existing = await read('key');
    if (existing) return existing;
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // Read and install atomically: concurrent tabs must use the same key.
    return transaction('readwrite', (store, done) => {
      store.get('key').onsuccess = event => { const value = event.target.result || created; store.put(value, 'key'); done(value); };
    });
  }
  return {
    cancel() { epoch++; },
    available: () => sequence(async () => {
      try { if (!globalThis.isSecureContext || !globalThis.indexedDB || !crypto.subtle) return false; await key(); return true; }
      catch { return false; }
    }),
    save(identity) {
      const ticket = epoch;
      return sequence(async () => {
        const privateBytes = encoder.encode(JSON.stringify(identity));
        try {
          const wrappingKey = await key(), iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad() }, wrappingKey, privateBytes);
          if (ticket !== epoch) return false;
          await transaction('readwrite', (store, done) => {
            if (ticket !== epoch) { done(false); return; }
            store.put({ v: 1, iv, ciphertext }, 'identity'); done(true);
          });
          return ticket === epoch;
        } finally { privateBytes.fill(0); }
      });
    },
    load: () => sequence(async () => {
      const record = await read('identity'); if (!record) return null;
      const wrappingKey = await read('key');
      if (record.v !== 1 || !wrappingKey) throw Error('保存的登录不可读取。');
      const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad() }, wrappingKey, record.ciphertext));
      try { return JSON.parse(decoder.decode(bytes)); } finally { bytes.fill(0); }
    }),
    clear() { epoch++; return sequence(() => transaction('readwrite', store => store.clear())); },
  };
}
