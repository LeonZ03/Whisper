import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function migrationStatements(sql) {
  const statements = []; let current = '';
  for (const line of sql.split('\n')) {
    const clean = line.replace(/--.*$/, '').trim(); if (!clean) continue;
    current += ' ' + clean;
    if (clean.endsWith(';') && (!/^CREATE TRIGGER/i.test(current.trim()) || /END;$/.test(clean))) { statements.push(current.trim()); current = ''; }
  }
  if (current.trim()) throw Error('Incomplete migration');
  return statements;
}
export async function realtimeCloudFixture({ through = 5, entry = 'cloud/worker.mjs' } = {}) {
  mkdirSync('.runtime', { recursive: true });
  const bundleDir = mkdtempSync(resolve('.runtime/realtime-backend-')), stateDir = mkdtempSync(join(tmpdir(), 'whisper-realtime-'));
  const outfile = join(bundleDir, 'worker.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'browser', format: 'esm', target: ['es2022'], define: { __APP_VERSION__: '"test"', __COMMIT__: '"isolated"' } });
  const text = value => ({ type: 'text', value });
  const mf = new Miniflare({ port: 0, cf: false, logRequests: false, telemetry: { enabled: false }, resourcePersistencePath: stateDir,
    workers: [{ config: { name: 'realtime-test', compatibilityDate: '2026-09-24', triggers: [{ type: 'fetch', pattern: '*/*' }],
      exports: { RealtimeHub: { type: 'durable-object', storage: 'sqlite' } },
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: readFileSync(outfile, 'utf8') } } },
      env: { DB: { type: 'd1', id: 'realtime-isolated' }, REALTIME: { type: 'durable-object', worker: 'realtime-test', exportName: 'RealtimeHub' },
        ENVIRONMENT: text('test'), AUTH_PEPPER: text('a'.repeat(64)), INSTANCE_ID: text('isolated'), ALLOWED_ORIGINS: text('https://test.whisper.invalid') }
    } }] });
  try {
    const url = String(await mf.ready).replace(/\/$/, ''), db = await mf.getD1Database('DB');
    const names = ['0001_initial.sql', '0002_accounts.sql', '0003_session_devices.sql', '0004_login_history.sql', '0005_realtime_journal.sql'].slice(0, through);
    const result = await db.batch(migrationStatements(names.map(name => readFileSync(`cloud/migrations/${name}`, 'utf8')).join('\n')).map(sql => db.prepare(sql)));
    const metrics = result.reduce((sum, r) => ({ rowsRead: sum.rowsRead + (r.meta?.rows_read || 0), rowsWritten: sum.rowsWritten + (r.meta?.rows_written || 0) }), { rowsRead: 0, rowsWritten: 0 });
    return { mf, db, url, metrics, async close() { await mf.dispose(); rmSync(stateDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); rmSync(bundleDir, { recursive: true, force: true }); } };
  } catch (error) { await mf.dispose(); rmSync(stateDir, { recursive: true, force: true }); rmSync(bundleDir, { recursive: true, force: true }); throw error; }
}
