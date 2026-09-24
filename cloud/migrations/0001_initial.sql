-- Cloud-only schema. Never run against data/whisper.sqlite.
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL, salt TEXT NOT NULL,
  vault_nonce TEXT NOT NULL, vault_cipher TEXT NOT NULL,
  auth_salt TEXT NOT NULL, auth_hash TEXT NOT NULL,
  auth_scheme TEXT NOT NULL DEFAULT 'client-pbkdf2-hkdf+hmac-v1',
  created_at INTEGER NOT NULL
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, a TEXT NOT NULL REFERENCES users(id),
  b TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(a,b), CHECK(a < b)
);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('text','image')),
  nonce TEXT, ciphertext TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE INDEX messages_conv ON messages(conversation_id,seq);
CREATE INDEX messages_expiry ON messages(expires_at);
CREATE TABLE image_payloads (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL, ciphertext TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id,created_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE storage_totals (id INTEGER PRIMARY KEY CHECK(id=1), messages INTEGER NOT NULL, bytes INTEGER NOT NULL);
INSERT INTO storage_totals VALUES(1,0,0);
CREATE TRIGGER user_cap BEFORE INSERT ON users WHEN (SELECT COUNT(*) FROM users)>=50
BEGIN SELECT RAISE(ABORT,'USER_CAP'); END;
CREATE TRIGGER message_cap BEFORE INSERT ON messages
WHEN (SELECT messages>=10000 OR bytes+COALESCE(length(NEW.ciphertext),0)>300000000 FROM storage_totals WHERE id=1)
BEGIN SELECT RAISE(ABORT,'STORAGE_CAP'); END;
CREATE TRIGGER message_insert AFTER INSERT ON messages BEGIN
 UPDATE storage_totals SET messages=messages+1,bytes=bytes+COALESCE(length(NEW.ciphertext),0) WHERE id=1;
 UPDATE conversations SET updated_at=MAX(updated_at+1,NEW.created_at) WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER message_delete AFTER DELETE ON messages BEGIN
 UPDATE storage_totals SET messages=messages-1,bytes=bytes-COALESCE(length(OLD.ciphertext),0) WHERE id=1;
 UPDATE conversations SET updated_at=MAX(updated_at+1,CAST(strftime('%s','now') AS INTEGER)*1000) WHERE id=OLD.conversation_id;
END;
CREATE TRIGGER payload_cap BEFORE INSERT ON image_payloads
WHEN length(NEW.ciphertext)>1900000 OR (SELECT bytes+length(NEW.ciphertext)>300000000 FROM storage_totals WHERE id=1)
BEGIN SELECT RAISE(ABORT,'STORAGE_CAP'); END;
CREATE TRIGGER payload_insert AFTER INSERT ON image_payloads BEGIN
 UPDATE storage_totals SET bytes=bytes+length(NEW.ciphertext) WHERE id=1;
END;
-- DELETE ... RETURNING claims the encrypted image exactly once. This trigger
-- runs in the SAME SQLite statement, so a second request cannot receive it.
CREATE TRIGGER payload_delete AFTER DELETE ON image_payloads BEGIN
 UPDATE storage_totals SET bytes=bytes-length(OLD.ciphertext) WHERE id=1;
 UPDATE messages SET consumed_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE id=OLD.message_id;
 UPDATE conversations SET updated_at=MAX(updated_at+1,CAST(strftime('%s','now') AS INTEGER)*1000)
 WHERE id=(SELECT conversation_id FROM messages WHERE id=OLD.message_id);
END;
CREATE TRIGGER session_cap AFTER INSERT ON sessions BEGIN
 DELETE FROM sessions WHERE user_id=NEW.user_id AND token_hash NOT IN
 (SELECT token_hash FROM sessions WHERE user_id=NEW.user_id ORDER BY created_at DESC,rowid DESC LIMIT 8);
END;
