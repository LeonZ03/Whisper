import { ready, b64, wipe, randomSalt, deriveCredentials, createIdentity, unlockIdentity, rewrapIdentity } from './crypto.mjs';
export function validateNewPassword(password) {
  if (typeof password !== 'string') throw new Error('请输入新密码。');
  const length = [...password.normalize('NFC')].length;
  if (length < 1 || length > 12) throw new Error('新密码必须为 1–12 个字符。');
  return length;
}
export async function prepareEnrollment(password, applicationMessage = '') {
  const passwordLength = validateNewPassword(password); await ready;
  let credentials, identity;
  try {
    const salt = randomSalt(); credentials = await deriveCredentials(password, salt);
    identity = createIdentity(credentials.vaultKey);
    return { salt, authKey: b64(credentials.authKey), publicKey: identity.publicKey,
      vault: identity.vault, passwordLength, applicationMessage };
  } finally { password = ''; wipe(credentials?.authKey); wipe(credentials?.vaultKey); wipe(identity?.secretKey); }
}
export async function preparePasswordChange(me, currentPassword, newPassword) {
  const passwordLength = validateNewPassword(newPassword);
  if (currentPassword.normalize('NFC') === newPassword.normalize('NFC')) throw new Error('新密码不能与当前密码相同。');
  let old, next, secretKey;
  try {
    old = await deriveCredentials(currentPassword, me.salt); secretKey = unlockIdentity(me, old.vaultKey);
    const salt = randomSalt(); next = await deriveCredentials(newPassword, salt);
    return { currentAuthKey: b64(old.authKey), authKey: b64(next.authKey), salt,
      publicKey: me.publicKey, vault: rewrapIdentity(secretKey, next.vaultKey),
      credentialVersion: me.credentialVersion, passwordLength };
  } finally { currentPassword = ''; newPassword = ''; wipe(old?.authKey); wipe(old?.vaultKey); wipe(next?.authKey); wipe(next?.vaultKey); wipe(secretKey); }
}
