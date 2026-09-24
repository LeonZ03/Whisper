-- Additive migration: existing member identities and ciphertext stay intact.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN root_activation_consumed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN application_message TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN reviewed_at INTEGER;
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
ALTER TABLE sessions ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id,created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE account_resets (user_id TEXT PRIMARY KEY REFERENCES users(id), token_hash TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE root_login_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, result TEXT NOT NULL, ip TEXT NOT NULL, location TEXT NOT NULL);
CREATE INDEX root_login_time ON root_login_log(timestamp);
CREATE TABLE admin_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, action TEXT NOT NULL, target_id TEXT, target_name TEXT);
CREATE TABLE auth_failures (scope TEXT PRIMARY KEY, failures INTEGER NOT NULL, until_at INTEGER NOT NULL);
CREATE TRIGGER reserve_root BEFORE INSERT ON users WHEN (NEW.username='root' AND NEW.role<>'root') OR (NEW.role='root' AND NEW.username<>'root')
BEGIN SELECT RAISE(ABORT,'RESERVED_ROOT'); END;
CREATE TRIGGER preserve_root BEFORE DELETE ON users WHEN OLD.role='root'
BEGIN SELECT RAISE(ABORT,'PROTECTED_ROOT'); END;
CREATE TRIGGER immutable_role BEFORE UPDATE OF role,username ON users WHEN NEW.role<>OLD.role OR NEW.username<>OLD.username
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IDENTITY'); END;
CREATE TRIGGER revoke_changed_credentials AFTER UPDATE OF credential_version ON users WHEN NEW.credential_version<>OLD.credential_version
BEGIN DELETE FROM sessions WHERE user_id=NEW.id; END;
CREATE TRIGGER consume_root_activation AFTER INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND role='root' AND auth_scheme='root-bootstrap-hmac-v1')
BEGIN UPDATE users SET root_activation_consumed=1 WHERE id=NEW.user_id; END;
DROP TRIGGER IF EXISTS user_cap;
CREATE TRIGGER user_cap BEFORE INSERT ON users WHEN NEW.role='member' AND (SELECT COUNT(*) FROM users WHERE role='member' AND status<>'deleted')>=50
BEGIN SELECT RAISE(ABORT,'USER_CAP'); END;
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
ALTER TABLE account_resets ADD COLUMN used_at INTEGER;
ALTER TABLE conversations ADD COLUMN history_from_seq INTEGER NOT NULL DEFAULT 0;
