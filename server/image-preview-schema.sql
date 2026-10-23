-- Additive local upgrade; existing images have no preview and remain viewable.
ALTER TABLE messages ADD COLUMN preview_nonce TEXT;
ALTER TABLE messages ADD COLUMN preview_ciphertext TEXT;
CREATE TRIGGER image_preview_consumed AFTER UPDATE OF consumed_at ON messages
WHEN NEW.consumed_at IS NOT NULL AND NEW.preview_ciphertext IS NOT NULL BEGIN
 UPDATE messages SET preview_nonce=NULL,preview_ciphertext=NULL WHERE id=NEW.id;
END;
