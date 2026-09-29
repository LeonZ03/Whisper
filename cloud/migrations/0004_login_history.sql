-- Bounded metadata history only. Existing sessions, credentials and messages
-- are unchanged, so the 0.5.4 Worker remains compatible during deployment.
CREATE TABLE login_history (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT UNIQUE NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 method TEXT NOT NULL CHECK(method IN ('web','app','cli')),
 device TEXT NOT NULL,
 ip TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 ended_at INTEGER,
 end_reason TEXT CHECK(end_reason IN ('logout','expired','revoked'))
);
CREATE INDEX login_history_user ON login_history(user_id,created_at DESC,seq DESC);
CREATE TRIGGER login_history_cap AFTER INSERT ON login_history BEGIN
 DELETE FROM login_history WHERE user_id=NEW.user_id AND id NOT IN
 (SELECT id FROM login_history WHERE user_id=NEW.user_id ORDER BY created_at DESC,seq DESC LIMIT 10);
END;
CREATE TRIGGER login_history_started AFTER INSERT ON session_devices BEGIN
 INSERT INTO login_history(id,user_id,method,device,ip,created_at,expires_at)
 SELECT NEW.public_id,s.user_id,NEW.method,NEW.device,NEW.ip,s.created_at,s.expires_at
 FROM sessions s WHERE s.token_hash=NEW.token_hash;
END;
CREATE TRIGGER login_history_ip AFTER UPDATE OF ip ON session_devices WHEN NEW.ip<>OLD.ip BEGIN
 UPDATE login_history SET ip=NEW.ip,location='{}' WHERE id=NEW.public_id;
END;
-- Runs before the device row is removed by its foreign-key cascade.
-- Explicit logout can set the more specific reason first in the same batch.
CREATE TRIGGER login_history_ended BEFORE DELETE ON sessions BEGIN
 UPDATE login_history SET
 ended_at=CASE WHEN OLD.expires_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
 THEN OLD.expires_at ELSE MAX(OLD.created_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) END,
 end_reason=CASE WHEN OLD.expires_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) THEN 'expired' ELSE 'revoked' END
 WHERE id=(SELECT public_id FROM session_devices WHERE token_hash=OLD.token_hash) AND ended_at IS NULL;
END;
-- Capture only metadata that exists. Previously deleted logins cannot be rebuilt.
INSERT INTO login_history(id,user_id,method,device,ip,created_at,expires_at)
 SELECT d.public_id,s.user_id,d.method,d.device,d.ip,s.created_at,s.expires_at
 FROM session_devices d JOIN sessions s ON s.token_hash=d.token_hash ORDER BY s.created_at;
