-- Additive, nullable fields. Old explicit-column writers/readers remain valid.
-- No account, key, session, lifetime or original-image claiming changes.
ALTER TABLE messages ADD COLUMN preview_nonce TEXT;
ALTER TABLE messages ADD COLUMN preview_ciphertext TEXT;
CREATE TRIGGER image_preview_consumed AFTER UPDATE OF consumed_at ON messages
WHEN NEW.consumed_at IS NOT NULL AND NEW.preview_ciphertext IS NOT NULL BEGIN
 UPDATE messages SET preview_nonce=NULL,preview_ciphertext=NULL WHERE id=NEW.id;
END;
-- Include preview ciphertext in the existing 300 MB budget, without raising it.
CREATE TRIGGER preview_cap BEFORE INSERT ON messages
WHEN NEW.preview_ciphertext IS NOT NULL AND ((NEW.type<>'image' OR length(NEW.preview_ciphertext)>2732)
 OR (SELECT bytes+COALESCE(length(NEW.ciphertext),0)+length(NEW.preview_ciphertext)>300000000 FROM storage_totals WHERE id=1))
BEGIN SELECT RAISE(ABORT,'STORAGE_CAP'); END;
CREATE TRIGGER preview_insert AFTER INSERT ON messages WHEN NEW.preview_ciphertext IS NOT NULL BEGIN
 UPDATE storage_totals SET bytes=bytes+COALESCE(length(NEW.preview_ciphertext),0) WHERE id=1;
END;
CREATE TRIGGER preview_delete AFTER DELETE ON messages WHEN OLD.preview_ciphertext IS NOT NULL BEGIN
 UPDATE storage_totals SET bytes=bytes-COALESCE(length(OLD.preview_ciphertext),0) WHERE id=1;
END;
CREATE TRIGGER preview_update AFTER UPDATE OF preview_ciphertext ON messages WHEN NEW.preview_ciphertext IS NOT OLD.preview_ciphertext BEGIN
 UPDATE storage_totals SET bytes=bytes+COALESCE(length(NEW.preview_ciphertext),0)-COALESCE(length(OLD.preview_ciphertext),0) WHERE id=1;
END;
