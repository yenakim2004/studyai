import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { D1Handle, D1Like, D1Statement } from '../../worker/src/hosted/store';

/**
 * TEST ONLY. A real local D1 (workerd's SQLite through wrangler's platform proxy, in memory), with the migrations drizzle-kit
 * generated applied in journal order, statement by statement. Nothing is persisted and nothing listens on a fixed port.
 */
export async function localD1(): Promise<{ db: D1Like; reset(): Promise<void>; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'studyai-d1-'));
  const configPath = join(dir, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({ name: 'studyai-hosted-test', compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'studyai-test', database_id: '00000000-0000-4000-8000-000000000000' }] }),
  );
  const proxy = await getPlatformProxy<{ DB: D1Like }>({ configPath, persist: false });
  const db = proxy.env.DB;
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    const sql = await readFile(join('drizzle', `${tag}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  return {
    db,
    reset: async () => void (await db.prepare('DELETE FROM chatgpt_account').run()),
    dispose: async () => {
      await proxy.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The statement name every store query starts with, as in `/* claimRefresh *\/ UPDATE ...`. */
const nameOf = (sql: string): string => /^\/\* (\w+) \*\//.exec(sql)?.[1] ?? '';

export interface D1Faults {
  /** Replaces a statement's SQL before it is prepared: the lever for mutation checks. */
  rewrite?: (name: string, sql: string) => string;
  /** Awaited before the statement executes: parks one instance at a named step while another runs. */
  before?: (name: string) => Promise<void> | void;
  /** Runs after the statement has executed on the database. Throwing here is "the write applied, then D1 threw". */
  after?: (name: string) => void;
}

/** Wraps a D1 handle (and any session it opens) so tests can inject faults by statement name. */
export function withFaults(db: D1Like, faults: D1Faults): D1Like {
  const wrapHandle = (h: D1Handle): D1Handle => ({
    prepare(sql: string) {
      const name = nameOf(sql);
      return wrapStatement(h.prepare(faults.rewrite?.(name, sql) ?? sql), name);
    },
  });
  const wrapStatement = (s: D1Statement, name: string): D1Statement => ({
    bind: (...values: unknown[]) => wrapStatement(s.bind(...values), name),
    first: async <T>() => {
      await faults.before?.(name);
      const r = await s.first<T>();
      faults.after?.(name);
      return r;
    },
    run: async () => {
      await faults.before?.(name);
      const r = await s.run();
      faults.after?.(name);
      return r;
    },
  });
  return { ...wrapHandle(db), withSession: db.withSession ? (c) => wrapHandle(db.withSession!(c)) : undefined };
}
