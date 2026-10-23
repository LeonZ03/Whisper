import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

test('preview migration preserves old data/writers/claim and existing storage cap', () => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  try {
    for (const name of ['0001_initial.sql','0002_accounts.sql','0003_session_devices.sql','0004_login_history.sql','0005_realtime_journal.sql']) db.exec(readFileSync('cloud/migrations/' + name, 'utf8'));
    const [a,b] = [randomUUID(), randomUUID()].sort(), conversation = randomUUID(), now = Date.now();
    for (const id of [a,b]) db.prepare('INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,'public','salt','nonce','vault','authsalt','hash',now);
    db.prepare('INSERT INTO conversations(id,a,b,created_at,updated_at) VALUES(?,?,?,?,?)').run(conversation,a,b,now,now);
    const insert = db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,created_at,expires_at) VALUES(?,?,?,'image',?,?)");
    const oldId = randomUUID(); insert.run(oldId,conversation,a,now,now+600000);
    db.prepare('INSERT INTO image_payloads VALUES(?,?,?)').run(oldId,'nonce','old-encrypted-image');
    const before = db.prepare('SELECT * FROM messages WHERE id=?').get(oldId), totals = db.prepare('SELECT * FROM storage_totals').get();
    db.exec(readFileSync('cloud/migrations/0006_image_previews.sql','utf8'));
    assert.deepEqual({...db.prepare('SELECT * FROM messages WHERE id=?').get(oldId)}, {...before,preview_nonce:null,preview_ciphertext:null});
    assert.deepEqual(db.prepare('SELECT * FROM storage_totals').get(),totals);
    assert.equal(db.prepare('DELETE FROM image_payloads WHERE message_id=? RETURNING ciphertext').get(oldId).ciphertext,'old-encrypted-image');
    assert.equal(db.prepare('DELETE FROM image_payloads WHERE message_id=? RETURNING ciphertext').get(oldId),undefined);
    // Old explicit-column statements continue working after the additive migration.
    const second = randomUUID(); insert.run(second,conversation,a,now,now+600000);
    const modern = randomUUID(); db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,created_at,expires_at,preview_nonce,preview_ciphertext) VALUES(?,?,?,'image',?,?,?,?)").run(modern,conversation,a,now,now+600000,'preview-nonce','preview-cipher');
    db.prepare('INSERT INTO image_payloads VALUES(?,?,?)').run(modern,'nonce','original-cipher');
    assert.equal(db.prepare('SELECT bytes FROM storage_totals').get().bytes,'preview-cipher'.length+'original-cipher'.length);
    db.prepare('DELETE FROM image_payloads WHERE message_id=? RETURNING ciphertext').get(modern);
    assert.equal(db.prepare('SELECT preview_ciphertext FROM messages WHERE id=?').get(modern).preview_ciphertext,null);
    assert.equal(db.prepare('SELECT bytes FROM storage_totals').get().bytes,0);
    db.prepare('UPDATE storage_totals SET bytes=299999999').run();
    assert.throws(()=>db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,created_at,expires_at,preview_nonce,preview_ciphertext) VALUES(?,?,?,'image',?,?,?,?)").run(randomUUID(),conversation,a,now,now+600000,'nonce','abc'),/STORAGE_CAP/);
  } finally { db.close(); }
});
