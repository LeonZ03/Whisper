import { randomBytes, randomUUID } from 'node:crypto';
import { ready, b64, wipe, randomSalt, deriveCredentials, createIdentity } from '../src/crypto.mjs';
import { validateNewPassword } from '../src/account-client.mjs';
import { mac } from '../cloud/security.mjs';
// The owner tool accepts the specified first-use password only with a random
// activation code. Neither belongs in the running service or deployment build.
export async function prepareOwnerMaterial(password) {
  validateNewPassword(password); await ready;
  const activationCode = randomBytes(32).toString('hex');
  const salt = randomSalt(), authSalt = b64(randomBytes(16));
  let credentials, identity;
  try {
    credentials = await deriveCredentials(password, salt);
    identity = createIdentity(credentials.vaultKey);
    return { activationCode, row: { id: randomUUID(), username: 'root', publicKey: identity.publicKey,
      salt, vault: identity.vault, authSalt,
      authHash: await mac(activationCode, 'auth-v1', 'root', authSalt, b64(credentials.authKey)) } };
  } finally { password = ''; wipe(credentials?.authKey); wipe(credentials?.vaultKey); wipe(identity?.secretKey); }
}
