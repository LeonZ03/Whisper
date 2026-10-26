import { randomUUID } from 'node:crypto';
import { SendQueue } from '../src/send-queue.mjs';
import { createIdentity, decryptMessage, encryptMessage, ready, wipe } from '../src/crypto.mjs';

const sampleCount = 200;
const queueCount = 5;
const mockRoundTripMs = 20;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
};
async function measureQueue({ includePreflight }) {
  let requests = 0;
  const queue = new SendQueue({ send: async () => {
    if (includePreflight) { requests++; await delay(mockRoundTripMs); }
    requests++; await delay(mockRoundTripMs);
  } });
  const started = performance.now();
  await Promise.all(Array.from({ length: queueCount }, (_, index) => queue.enqueue({
    id: `synthetic-${index}`, expiresAt: Date.now() + 60_000,
  }, {})));
  return { requests, elapsedMs: Number((performance.now() - started).toFixed(1)) };
}

await ready;
const vaultKey = new Uint8Array(32);
const senderIdentity = createIdentity(vaultKey);
const recipientIdentity = createIdentity(vaultKey);
const sender = { id: randomUUID(), ...senderIdentity };
const recipient = { id: randomUUID(), ...recipientIdentity };
const conversationId = randomUUID();
const encryptionTimes = [], decryptionTimes = [];
try {
  for (let i = 0; i < 20; i++) {
    const warm = encryptMessage(sender, recipient, conversationId, 'synthetic warmup');
    decryptMessage({ ...warm, senderId: sender.id, conversationId }, recipient, sender);
  }
  const envelopes = [];
  for (let i = 0; i < sampleCount; i++) {
    const started = performance.now();
    const envelope = encryptMessage(sender, recipient, conversationId, `synthetic short message ${i}`);
    encryptionTimes.push(performance.now() - started);
    envelopes.push({ ...envelope, senderId: sender.id, conversationId });
  }
  for (const envelope of envelopes) {
    const started = performance.now();
    decryptMessage(envelope, recipient, sender);
    decryptionTimes.push(performance.now() - started);
  }

  const before = await measureQueue({ includePreflight: true });
  const after = await measureQueue({ includePreflight: false });
  console.log(JSON.stringify({
    scope: 'local synthetic only; mock HTTP round trip; no network or real accounts',
    queue: { messages: queueCount, mockedRoundTripMs: mockRoundTripMs, before, after },
    crypto: {
      messages: sampleCount,
      operation: 'libsodium encryptMessage/decryptMessage; random temporary keys; no password KDF',
      encryptMs: { p50: percentile(encryptionTimes, 0.50), p95: percentile(encryptionTimes, 0.95) },
      decryptMs: { p50: percentile(decryptionTimes, 0.50), p95: percentile(decryptionTimes, 0.95) },
    },
  }, null, 2));
} finally {
  wipe(sender.secretKey); wipe(recipient.secretKey); wipe(vaultKey);
}
