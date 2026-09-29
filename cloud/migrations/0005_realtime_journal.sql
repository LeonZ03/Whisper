-- Additive metadata only. Existing writers, image claims and rollback stay compatible.
CREATE TABLE realtime_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('message','remove','conversation','account')),
  entity_id TEXT NOT NULL,
  conversation_id TEXT,
  a TEXT NOT NULL,
  b TEXT
);
CREATE INDEX realtime_journal_a ON realtime_journal(a,seq);
CREATE INDEX realtime_journal_b ON realtime_journal(b,seq);
CREATE TRIGGER realtime_journal_bound AFTER INSERT ON realtime_journal BEGIN
  DELETE FROM realtime_journal WHERE seq<=NEW.seq-10000;
END;
CREATE TRIGGER realtime_message_insert AFTER INSERT ON messages BEGIN
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b)
  SELECT 'message',NEW.id,c.id,c.a,c.b FROM conversations c WHERE c.id=NEW.conversation_id;
END;
CREATE TRIGGER realtime_message_delete AFTER DELETE ON messages BEGIN
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b)
  SELECT 'remove',OLD.id,c.id,c.a,c.b FROM conversations c WHERE c.id=OLD.conversation_id;
END;
CREATE TRIGGER realtime_message_update AFTER UPDATE OF consumed_at,expires_at ON messages
WHEN NEW.consumed_at IS NOT OLD.consumed_at OR NEW.expires_at<>OLD.expires_at BEGIN
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b)
  SELECT 'message',NEW.id,c.id,c.a,c.b FROM conversations c WHERE c.id=NEW.conversation_id;
END;
CREATE TRIGGER realtime_conversation_insert AFTER INSERT ON conversations BEGIN
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b) VALUES('conversation',NEW.id,NEW.id,NEW.a,NEW.b);
END;
CREATE TRIGGER realtime_conversation_update AFTER UPDATE OF archived_at,history_from_seq ON conversations
WHEN NEW.archived_at IS NOT OLD.archived_at OR NEW.history_from_seq<>OLD.history_from_seq BEGIN
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b) VALUES('conversation',NEW.id,NEW.id,NEW.a,NEW.b);
END;
CREATE TRIGGER realtime_conversation_delete BEFORE DELETE ON conversations BEGIN
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b) VALUES('conversation',OLD.id,OLD.id,OLD.a,OLD.b);
END;
CREATE TRIGGER realtime_user_insert AFTER INSERT ON users BEGIN
  INSERT INTO realtime_journal(kind,entity_id,a) VALUES('account',NEW.id,NEW.id);
END;
CREATE TRIGGER realtime_user_update AFTER UPDATE OF public_key,status,credential_version,must_change ON users
WHEN NEW.public_key<>OLD.public_key OR NEW.status<>OLD.status OR NEW.credential_version<>OLD.credential_version OR NEW.must_change<>OLD.must_change BEGIN
  INSERT INTO realtime_journal(kind,entity_id,a) VALUES('account',NEW.id,NEW.id);
  INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b)
  SELECT 'conversation',c.id,c.id,c.a,c.b FROM conversations c WHERE c.a=NEW.id OR c.b=NEW.id;
END;
