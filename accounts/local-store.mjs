// Adapt only this application's SQLite database to the shared asynchronous API.
export function localStore(db) {
  const prepare = (sql, args = []) => ({
    bind: (...values) => prepare(sql, values),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
    execute() {
      const q = db.prepare(sql);
      if (/\bRETURNING\b/i.test(sql) || /^\s*SELECT\b/i.test(sql)) return { results: q.all(...args) };
      return { results: [], meta: { changes: q.run(...args).changes } };
    }
  });
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => s.execute()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
