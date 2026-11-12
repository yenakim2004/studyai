import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devVars, parsePort, planSecrets, takeLock, wranglerArgs } from '../scripts/local.mjs';
import { parseLoopback } from '../worker/src/loopback';

const root = resolve(__dirname, '..');

describe('scripts/local.mjs (pnpm local)', () => {
  it('uses one fixed port unless told otherwise, and only an unprivileged one', () => {
    expect(parsePort(undefined)).toBe(8790);
    expect(parsePort('9000')).toBe(9000);
    for (const bad of ['80', '0', '65536', '8790 ', 'abc', '-1', '8e3']) expect(parsePort(bad), bad).toBeNull();
  });

  it('creates the seal key once, reuses it, and refuses to overwrite a damaged file', () => {
    const made = planSecrets(undefined);
    if (made.kind === 'invalid') throw new Error('unreachable');
    expect(made).toEqual({ kind: 'create', secrets: { v: 1, sealKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } });
    expect(planSecrets(JSON.stringify(made.secrets))).toEqual({ kind: 'reuse', secrets: made.secrets });
    for (const bad of ['', '{', '{}', JSON.stringify({ v: 1, sealKey: 'short' }), JSON.stringify({ v: 2, sealKey: made.secrets.sealKey })]) expect(planSecrets(bad).kind, bad).toBe('invalid');
  });

  it('reuses the seal key of a secrets file from the owner-key release, ignores its other fields and never creates a new key', () => {
    const sealKey = randomBytes(32).toString('base64url');
    const legacy = JSON.stringify({ v: 1, ownerKey: `sak_${randomBytes(32).toString('base64url')}`, sessionSecret: randomBytes(48).toString('base64url'), sealKey }, null, 2);
    expect(planSecrets(legacy, () => Buffer.alloc(32, 7))).toEqual({ kind: 'reuse', secrets: { v: 1, sealKey } });
    expect(planSecrets(JSON.stringify({ v: 1, ownerKey: 'anything', sealKey }))).toEqual({ kind: 'reuse', secrets: { v: 1, sealKey } });
  });

  it('writes an env file with exactly the loopback host and the same seal key, and nothing about a key or a session', () => {
    const sealKey = randomBytes(32).toString('base64url');
    const text = devVars({ secrets: { v: 1, sealKey }, port: 8790 });
    const env = Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(env).toEqual({ STUDYAI_LOOPBACK: '127.0.0.1:8790', CHATGPT_SEAL_KEY: sealKey });
    expect(parseLoopback(env)).toEqual({ host: '127.0.0.1:8790', origin: 'http://127.0.0.1:8790', redirectUri: 'http://127.0.0.1:8790/auth/callback' });
  });

  it('has no owner key, session secret or Gemini key anywhere in the launcher', () => {
    const source = readFileSync(join(root, 'scripts/local.mjs'), 'utf8');
    for (const gone of ['ownerKey', 'owner-key', 'OWNER_KEY', 'SESSION_SECRET', 'sessionSecret', 'GEMINI', 'ALLOWED_HOSTS', '/api/auth/', '소유자']) expect(source, gone).not.toContain(gone);
  });

  it('runs the production entry on 127.0.0.1 with secrets only in the env file, never on the command line', () => {
    const args = wranglerArgs({ port: 8790, dir: '/x/.studyai-local' });
    expect(args).toEqual(expect.arrayContaining(['--ip', '127.0.0.1', '--port', '8790', '--env-file', '/x/.studyai-local/dev.vars', '--persist-to', '/x/.studyai-local/state', '--local']));
    expect(args[args.indexOf('-c') + 1]).toBe(join(root, 'wrangler.jsonc'));
    expect(args).not.toContain('--var');
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toMatch(/"main": "worker\/src\/index\.ts"/);
  });

  it('refuses existing locks, including incomplete metadata and a dead launcher whose Worker may remain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyai-lock-'));
    const file = join(dir, 'launcher.lock');
    try {
      for (const text of ['', '{', JSON.stringify({ pid: process.pid, port: 8790 }), JSON.stringify({ pid: 2 ** 22 + 12345, port: 8790 })]) {
        writeFileSync(file, text);
        expect(takeLock(file, 8791).ok).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe(text);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases only its own lock and cannot remove a later launcher lock on repeated cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyai-lock-'));
    const file = join(dir, 'launcher.lock');
    try {
      const first = takeLock(file, 8790);
      if (!first.ok) throw new Error('first lock refused');
      first.release();
      expect(existsSync(file)).toBe(false);
      const second = takeLock(file, 8791);
      if (!second.ok) throw new Error('second lock refused');
      first.release();
      expect(JSON.parse(readFileSync(file, 'utf8')).port).toBe(8791);
      renameSync(file, `${file}.old`);
      writeFileSync(file, 'replacement');
      second.release();
      expect(readFileSync(file, 'utf8')).toBe('replacement');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a busy port instead of moving the library to another browser origin, before building anything', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), 'studyai-local-'));
    try {
      const r = spawnSync(process.execPath, ['scripts/local.mjs'], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, STUDYAI_PORT: String(port), STUDYAI_LOCAL_DIR: dir } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`포트 ${port}이(가) 사용 중입니다`);
      expect(r.stdout).not.toContain('빌드');
      expect(existsSync(join(dir, 'launcher.lock'))).toBe(false);
    } finally {
      srv.close();
    }
  });

  it.skipIf(!existsSync(join(root, 'dist/index.html')))(
    'starts on a legacy secrets file with no key step, and closing the terminal (SIGHUP) releases the lock and the port',
    async () => {
      const port = await new Promise<number>((r) => {
        const srv = createServer().listen(0, '127.0.0.1', () => {
          const p = (srv.address() as { port: number }).port;
          srv.close(() => r(p));
        });
      });
      const dir = mkdtempSync(join(tmpdir(), 'studyai-local-'));
      const legacy = `${JSON.stringify({ v: 1, ownerKey: `sak_${randomBytes(32).toString('base64url')}`, sessionSecret: randomBytes(48).toString('base64url'), sealKey: randomBytes(32).toString('base64url') }, null, 2)}\n`;
      writeFileSync(join(dir, 'secrets.json'), legacy, { mode: 0o600 });
      const child = spawn(process.execPath, ['scripts/local.mjs', '--no-build'], { cwd: root, env: { ...process.env, STUDYAI_PORT: String(port), STUDYAI_LOCAL_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
      try {
        await Promise.race([
          new Promise<void>((r) => {
            const t = setInterval(() => {
              if (out.includes('StudyAI가 실행 중입니다')) clearInterval(t), r();
            }, 200);
          }),
          exited.then((code) => Promise.reject(new Error(`launcher exited early (${code}): ${out}`))),
        ]);
        expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(legacy);
        expect(existsSync(join(dir, 'owner-key.txt'))).toBe(false);
        expect(out).not.toMatch(/sak_|소유자 키|owner key/i);
        const sealKey = (JSON.parse(legacy) as { sealKey: string }).sealKey;
        expect(out).not.toContain(sealKey);
        expect(readFileSync(join(dir, 'dev.vars'), 'utf8')).toBe(`STUDYAI_LOOPBACK=127.0.0.1:${port}\nCHATGPT_SEAL_KEY=${sealKey}\n`);
        const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as { signInAvailable: boolean; connection: { kind: string } };
        expect(status).toMatchObject({ signInAvailable: true, connection: { kind: 'disconnected' } });
        expect((await fetch(`http://127.0.0.1:${port}/api/auth/session`)).status).toBe(404);
        expect(existsSync(join(dir, 'launcher.lock'))).toBe(true);

        process.kill(-child.pid!, 'SIGHUP'); // what closing the terminal window does to the whole process group
        await exited;
        expect(existsSync(join(dir, 'launcher.lock'))).toBe(false);
        await expect.poll(() => new Promise((r) => { const srv = createServer().once('error', () => r(false)).listen(port, '127.0.0.1', () => srv.close(() => r(true))); }), { timeout: 10_000 }).toBe(true);
      } finally {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
