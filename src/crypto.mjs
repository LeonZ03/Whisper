import sodium from 'libsodium-wrappers';
export const ready = sodium.ready;
export const b64 = (bytes) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
export const unb64 = (text) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
const encoder = new TextEncoder();
export function wipe(bytes) { if (bytes instanceof Uint8Array) sodium.memzero(bytes); }
export function randomSalt() { return b64(sodium.randombytes_buf(16)); }
export async function deriveCredentials(password, salt) {
  const raw = encoder.encode(password.normalize('NFC'));
  const material = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveBits']); wipe(raw);
  const master = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64(salt), iterations: 600000, hash: 'SHA-256' }, material, 256));
  const hkdf = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']); wipe(master);
  const derive = async (label) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: encoder.encode(label) }, hkdf, 256));
  return { authKey: await derive('Whisper authentication v1'), vaultKey: await derive('Whisper vault encryption v1') };
}
export function createIdentity(vaultKey) {
  const pair = sodium.crypto_box_keypair(); const nonce = sodium.randombytes_buf(24);
  const vault = { nonce: b64(nonce), ciphertext: b64(sodium.crypto_secretbox_easy(pair.privateKey, nonce, vaultKey)) };
  return { publicKey: b64(pair.publicKey), secretKey: pair.privateKey, vault };
}
export function unlockIdentity(user, vaultKey) {
  const secretKey = sodium.crypto_secretbox_open_easy(unb64(user.vault.ciphertext), unb64(user.vault.nonce), vaultKey);
  if (b64(sodium.crypto_scalarmult_base(secretKey)) !== user.publicKey) { wipe(secretKey); throw new Error('身份密钥校验失败。'); }
  return secretKey;
}
export function encryptMessage(user, peer, conversationId, body, { type = 'text', ttlMs = 86400000, mime } = {}) {
  if (!['text', 'image'].includes(type)) throw new Error('Unsupported message type');
  const id = crypto.randomUUID(); const expiresAt = Date.now() + ttlMs;
  const payload = { v: 1, id, conversationId, senderId: user.id, recipientId: peer.id, type, expiresAt, body };
  if (mime) payload.mime = mime;
  const nonce = sodium.randombytes_buf(24); const plain = encoder.encode(JSON.stringify(payload));
  const ciphertext = b64(sodium.crypto_box_easy(plain, nonce, unb64(peer.publicKey), user.secretKey)); wipe(plain);
  return { id, type, nonce: b64(nonce), ciphertext, expiresAt };
}
function decryptPayload(message, user, peer) {
  if (!message.ciphertext || !message.nonce) throw new Error('消息已经清理。');
  const raw = sodium.crypto_box_open_easy(unb64(message.ciphertext), unb64(message.nonce), unb64(peer.publicKey), user.secretKey);
  let payload; try { payload = JSON.parse(new TextDecoder().decode(raw)); } finally { wipe(raw); }
  const expectedRecipient = message.senderId === user.id ? peer.id : user.id;
  if (payload.v !== 1 || payload.id !== message.id || payload.conversationId !== message.conversationId ||
      payload.senderId !== message.senderId || payload.recipientId !== expectedRecipient ||
      ![user.id, peer.id].includes(payload.senderId) || payload.type !== message.type || payload.expiresAt !== message.expiresAt ||
      typeof payload.body !== 'string') throw new Error('消息完整性校验失败。');
  if (payload.expiresAt <= Date.now()) throw new Error('消息已过期。');
  return payload;
}
export function decryptMessage(message, user, peer) {
  const payload = decryptPayload(message, user, peer);
  if (payload.purpose !== undefined) throw new Error('消息用途不匹配。');
  return payload;
}
// A preview is only a tiny RGB grid, encrypted independently with a fresh nonce.
// Bind it to the original envelope; it can never be substituted for the image.
export function encryptImagePreview(message, user, peer, conversationId, preview) {
  if (message.type !== 'image') throw new Error('图片预览类型无效。');
  const payload = { v: 1, purpose: 'image-preview-v1', id: message.id, conversationId,
    senderId: user.id, recipientId: peer.id, type: 'image', expiresAt: message.expiresAt,
    body: b64(preview.pixels), width: preview.width, height: preview.height };
  const nonce = sodium.randombytes_buf(24), plain = encoder.encode(JSON.stringify(payload));
  try { return { nonce: b64(nonce), ciphertext: b64(sodium.crypto_box_easy(plain, nonce, unb64(peer.publicKey), user.secretKey)) }; }
  finally { wipe(plain); }
}
export function decryptImagePreview(message, user, peer) {
  if (message.type !== 'image' || message.consumedAt || !message.preview) throw new Error('预览不可用。');
  const payload = decryptPayload({ ...message, nonce: message.preview.nonce, ciphertext: message.preview.ciphertext }, user, peer);
  if (payload.purpose !== 'image-preview-v1' || !Number.isInteger(payload.width) || !Number.isInteger(payload.height) ||
      payload.width < 1 || payload.width > 8 || payload.height < 1 || payload.height > 8 || payload.body.length > 256) throw new Error('图片预览无效。');
  const pixels = unb64(payload.body);
  if (pixels.length !== payload.width * payload.height * 3) { wipe(pixels); throw new Error('图片预览无效。'); }
  return { width: payload.width, height: payload.height, pixels };
}
export async function safetyCode(user, peer) {
  const material = [user, peer].sort((a, b) => a.id.localeCompare(b.id)).map((p) => `${p.id}:${p.publicKey}`).join('|');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('Whisper safety code v1|' + material)));
  return [...hash].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join(' ');
}

// Changing an account password re-encrypts the SAME identity key, not its messages.
export function rewrapIdentity(secretKey, vaultKey) {
  const nonce = sodium.randombytes_buf(24);
  return { nonce: b64(nonce), ciphertext: b64(sodium.crypto_secretbox_easy(secretKey, nonce, vaultKey)) };
}
