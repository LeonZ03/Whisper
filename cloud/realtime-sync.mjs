import { fail, UUID } from './security.mjs';

export const SESSION_VALID_SQL = "SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.credential_version=u.credential_version AND u.status='active' AND u.role='member' AND u.must_change=0";
export function syncParameters(url) {
  const selected = url.searchParams.get('conversationId');
  if (selected !== null && !UUID.test(selected)) fail(400, '无效的会话。');
  const raw = url.searchParams.get('cursor');
  if (raw !== null && (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))) fail(400, '无效的同步游标。');
  return { selected, cursor: raw === null ? null : Number(raw) };
}

// One SQLite statement gives authorization, watermark and payload the same view.
// Never copy message ciphertext or session metadata into the journal.
export function syncStatement(db, { userId, tokenHash, selected, cursor, now = Date.now(), local = false }) {
  const updated = local ? 'COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.expires_at>p.now),c.created_at)' : 'c.updated_at';
  return db.prepare(`WITH
    p AS MATERIALIZED (SELECT ? AS uid,? AS token,? AS selected,? AS wanted,? AS now),
    authorized AS (SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id,p WHERE s.token_hash=p.token AND u.id=p.uid AND s.expires_at>p.now AND s.credential_version=u.credential_version AND u.status='active' AND u.role='member' AND u.must_change=0),
    bounds AS MATERIALIZED (SELECT COALESCE((SELECT MAX(seq) FROM realtime_journal),0) AS high,COALESCE((SELECT MIN(seq) FROM realtime_journal),1) AS low),
    state AS MATERIALIZED (SELECT high,CASE WHEN p.wanted IS NULL OR p.wanted>high OR p.wanted<low-1 OR EXISTS(SELECT 1 FROM realtime_journal j WHERE j.seq>p.wanted AND j.conversation_id=p.selected AND j.kind='conversation' AND (j.a=p.uid OR j.b=p.uid)) THEN 1 ELSE 0 END AS reset FROM bounds,p),
    events AS MATERIALIZED (SELECT j.* FROM realtime_journal j,p,state WHERE state.reset=0 AND j.seq>p.wanted AND j.seq<=state.high AND (j.a=p.uid OR j.b=p.uid) ORDER BY j.seq LIMIT 201),
    page AS MATERIALIZED (SELECT * FROM events ORDER BY seq LIMIT 200),
    checkpoint AS (SELECT CASE WHEN (SELECT COUNT(*) FROM events)>200 THEN (SELECT MAX(seq) FROM page) ELSE state.high END AS cursor,(SELECT COUNT(*) FROM events)>200 AS more FROM state),
    live AS MATERIALIZED (SELECT c.*,u.id AS peer_id,u.username AS peer_name,u.public_key AS peer_key,${updated} AS updated FROM conversations c,p JOIN users u ON u.id=CASE WHEN c.a=p.uid THEN c.b ELSE c.a END JOIN users own ON own.id=p.uid WHERE (c.a=p.uid OR c.b=p.uid) AND c.archived_at IS NULL AND u.status='active' AND u.role='member' AND own.status='active'),
    selected AS MATERIALIZED (SELECT c.* FROM live c,p WHERE c.id=p.selected),
    changed_conversations AS MATERIALIZED (SELECT DISTINCT conversation_id AS id FROM page WHERE conversation_id IS NOT NULL),
    conversation_rows AS (SELECT c.* FROM live c,state WHERE state.reset=1 OR c.id IN (SELECT id FROM changed_conversations) ORDER BY c.updated DESC,c.id),
    snapshot_messages AS (SELECT m.* FROM state CROSS JOIN selected c CROSS JOIN p CROSS JOIN messages m WHERE state.reset=1 AND m.conversation_id=c.id AND m.expires_at>p.now AND m.seq>c.history_from_seq ORDER BY m.seq DESC LIMIT 200),
    delta_messages AS (SELECT DISTINCT m.* FROM page j CROSS JOIN messages m CROSS JOIN selected c CROSS JOIN p CROSS JOIN state WHERE j.kind='message' AND m.id=j.entity_id AND state.reset=0 AND m.conversation_id=c.id AND m.expires_at>p.now AND m.seq>c.history_from_seq ORDER BY m.seq),
    message_rows AS (SELECT * FROM snapshot_messages WHERE (SELECT reset FROM state)=1 UNION ALL SELECT * FROM delta_messages WHERE (SELECT reset FROM state)=0),
    removed_messages AS (SELECT DISTINCT j.entity_id AS id FROM page j,p WHERE j.conversation_id=p.selected AND j.kind IN ('message','remove') AND NOT EXISTS (SELECT 1 FROM messages m,selected c WHERE m.id=j.entity_id AND m.conversation_id=c.id AND m.expires_at>p.now AND m.seq>c.history_from_seq))
    SELECT (SELECT COUNT(*) FROM authorized) AS authorized,json_object(
      'version',1,'cursor',checkpoint.cursor,'reset',json(CASE WHEN state.reset THEN 'true' ELSE 'false' END),'more',json(CASE WHEN checkpoint.more THEN 'true' ELSE 'false' END),
      'conversationId',(SELECT id FROM selected),'serverTime',p.now,
      'conversations',json(COALESCE((SELECT json_group_array(json_object('id',id,'peer',json_object('id',peer_id,'username',peer_name,'publicKey',peer_key),'updatedAt',updated)) FROM conversation_rows),'[]')),
      'removedConversations',json(COALESCE((SELECT json_group_array(id) FROM changed_conversations WHERE id NOT IN (SELECT id FROM live)),'[]')),
      'messages',json(COALESCE((SELECT json_group_array(json_object('seq',seq,'id',id,'conversationId',conversation_id,'senderId',sender_id,'type',type,'nonce',CASE WHEN type='text' THEN nonce ELSE NULL END,'ciphertext',CASE WHEN type='text' THEN ciphertext ELSE NULL END,'createdAt',created_at,'expiresAt',expires_at,'consumedAt',consumed_at)) FROM (SELECT * FROM message_rows ORDER BY seq)),'[]')),
      'removed',json(COALESCE((SELECT json_group_array(id) FROM removed_messages),'[]'))
    ) AS payload FROM state,checkpoint,p`).bind(userId, tokenHash, selected, cursor, now);
}

export async function readSync(db, options) {
  const result = await syncStatement(db, options).first();
  if (!result?.authorized) fail(401, '登录已失效，请重新登录。');
  return JSON.parse(result.payload);
}

export async function journalHigh(db) {
  return (await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM realtime_journal').first()).seq;
}
// The participant indexes cover a/b, but choosing them here scans old entries.
// Force the INTEGER PRIMARY KEY range so only newly committed events are read.
export const JOURNAL_AUDIENCE_SQL = 'SELECT a,b FROM realtime_journal NOT INDEXED WHERE seq>?';
export const journalAudienceIds = rows => [...new Set(rows.flatMap(row => [row.a, row.b]).filter(id => id != null))];
export async function journalAudience(db, after) {
  const result = await db.prepare(JOURNAL_AUDIENCE_SQL).bind(after).all();
  return journalAudienceIds(result.results);
}
