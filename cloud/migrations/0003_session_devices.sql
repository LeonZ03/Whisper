-- Additive side table; old explicit session inserts remain compatible.
-- No tokens or cookies are returned from the devices endpoint.
CREATE TABLE session_devices (
 token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 public_id TEXT UNIQUE NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('web','app','cli')),
 device TEXT NOT NULL,
 ip TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS session_cap AFTER INSERT ON sessions BEGIN
 DELETE FROM sessions WHERE user_id=NEW.user_id AND token_hash NOT IN
 (SELECT token_hash FROM sessions WHERE user_id=NEW.user_id ORDER BY created_at DESC,rowid DESC LIMIT 8);
END;
CREATE TRIGGER revoke_inactive_sessions AFTER UPDATE OF status ON users WHEN NEW.status<>'active'
BEGIN DELETE FROM sessions WHERE user_id=NEW.id; END;
