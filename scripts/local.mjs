#!/usr/bin/env node
/**
 * `pnpm local`: runs the real StudyAI Worker and app on http://127.0.0.1:<port> for the person using this computer, with
 * persistent private state, so the ChatGPT plan sign-in (a loopback-only flow) works. There is no key and no StudyAI login:
 * the API accepts only requests from the app opened at that exact address (worker/src/loopback.ts). The launcher only
 * provisions: the seal key on first run, an env file, the build, and `wrangler dev` with the production entry.
 *
 * Everything it writes is under .studyai-local/ (git-ignored; folder 0700, launcher secret files 0600):
 *   secrets.json    the ChatGPT seal key. Created once, never rewritten. A file from an earlier release may also hold
 *                   fields nothing reads any more; they are left as they are.
 *   dev.vars        what the Worker gets through --env-file. Rewritten each run. Never passed on the command line.
 *   state/          the Durable Object's storage (the sealed ChatGPT sign-in).
 *   launcher.lock   one launcher per folder, so two Workers never refresh the same rotating token.
 * It never reads the repository's .dev.vars, and never deletes state.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 8790;

/** STUDYAI_PORT, an integer 1024 to 65535. The listener is always 127.0.0.1; there is no host option. */
export function parsePort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^[0-9]{4,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1024 && n <= 65_535 ? n : null;
}

const isSealKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').length === 32;

/**
 * Pure. Reuse the seal key, create it when there is no file, refuse anything else rather than overwrite it. The seal key
 * opens the stored ChatGPT sign-in, so a file from an earlier release is reused for its `sealKey` alone, whatever else it holds.
 */
export function planSecrets(existingText, random = randomBytes) {
  if (existingText === undefined) return { kind: 'create', secrets: { v: 1, sealKey: random(32).toString('base64url') } };
  let s;
  try {
    s = JSON.parse(existingText);
  } catch {
    return { kind: 'invalid' };
  }
  return s && s.v === 1 && isSealKey(s.sealKey) ? { kind: 'reuse', secrets: { v: 1, sealKey: s.sealKey } } : { kind: 'invalid' };
}

/** Pure. The env file for one port: the loopback address and the seal key, nothing else. */
export function devVars({ secrets, port }) {
  return `STUDYAI_LOOPBACK=127.0.0.1:${port}\nCHATGPT_SEAL_KEY=${secrets.sealKey}\n`;
}

/** Pure. The wrangler arguments: file paths and the port only, never a secret. */
export function wranglerArgs({ port, dir }) {
  return ['dev', '-c', join(ROOT, 'wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port), '--local', '--persist-to', join(dir, 'state'), '--env-file', join(dir, 'dev.vars'), '--log-level', 'warn', '--show-interactive-dev-session=false'];
}

/** Never steal an existing lock: its metadata may still be writing, or its Worker may outlive the launcher. */
export function takeLock(file, port) {
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    let other;
    try {
      other = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      other = null;
    }
    return { ok: false, pid: Number.isInteger(other?.pid) ? other.pid : null, port: Number.isInteger(other?.port) ? other.port : null };
  }
  const owned = fstatSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = lstatSync(file);
      if (current.dev === owned.dev && current.ino === owned.ino) rmSync(file);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  };
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, port }));
  } catch (e) {
    release();
    throw e;
  } finally {
    closeSync(fd);
  }
  return { ok: true, release };
}

export function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

function writePrivate(file, text, flag = 'w') {
  writeFileSync(file, text, { mode: 0o600, flag });
  chmodSync(file, 0o600);
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writePrivate(tmp, text, 'wx');
  renameSync(tmp, file);
}

const fail = (message) => {
  console.error(`\n${message}`);
  process.exitCode = 1;
};

/** Health, then the status the app itself reads, asked the way the app asks it. Prints nothing from the answer. */
async function selfCheck(origin, signal) {
  const end = Date.now() + 120_000;
  for (;;) {
    if (signal.aborted) return '중단되었습니다.';
    try {
      const h = await fetch(`${origin}/api/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
      if (h.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end) return 'StudyAI 서버가 2분 안에 시작되지 않았습니다.';
    await new Promise((r) => setTimeout(r, 500));
  }
  const res = await fetch(`${origin}/api/status`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  const status = res.ok ? await res.json() : null;
  if (status?.signInAvailable !== true) return '서버가 ChatGPT 연결을 켜지 않았습니다(--env-file의 루프백 주소나 봉인 키 누락). 반쯤 설정된 서버를 띄우지 않고 멈춥니다.';
  return null;
}

async function main() {
  const port = parsePort(process.env.STUDYAI_PORT);
  if (port === null) return fail('STUDYAI_PORT는 1024~65535 사이의 숫자여야 합니다.');
  const dir = resolve(process.env.STUDYAI_LOCAL_DIR || join(ROOT, '.studyai-local'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const lock = takeLock(join(dir, 'launcher.lock'), port);
  if (!lock.ok) return fail(`StudyAI 실행 잠금이 있습니다${lock.pid ? ` (pid ${lock.pid}, 포트 ${lock.port})` : ''}. 실행 중인 창에서 Ctrl+C로 끈 뒤 다시 실행하세요. 비정상 종료 후라면 이 폴더를 쓰는 서버가 모두 종료되었는지 확인한 뒤 ${join(dir, 'launcher.lock')} 파일만 지우세요.`);
  let child = null;
  let stopping = false;
  let failed = false;
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    else lock.release();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Closing the terminal window sends SIGHUP, whose default action skips 'exit' and would leave the lock behind.
  process.on('SIGHUP', stop);
  process.on('exit', () => lock.release());

  if (!(await portFree(port)))
    return lock.release(), fail(`포트 ${port}이(가) 사용 중입니다. 포트가 바뀌면 브라우저 저장소(내 강의 자료)도 다른 곳이 되므로 자동으로 바꾸지 않습니다. 사용 중인 프로그램을 끄거나, 다른 포트를 계속 쓸 생각이면 STUDYAI_PORT를 지정하세요.`);
  if (stopping) return;

  const secretsFile = join(dir, 'secrets.json');
  const plan = planSecrets(existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : undefined);
  if (plan.kind === 'invalid') return lock.release(), fail(`${secretsFile} 파일을 읽을 수 없습니다. 덮어쓰지 않고 멈춥니다. 파일을 고치거나 직접 지운 뒤 다시 실행하세요(지우면 저장된 ChatGPT 연결도 다시 해야 합니다).`);
  if (plan.kind === 'create') writePrivate(secretsFile, `${JSON.stringify(plan.secrets, null, 2)}\n`, 'wx');
  writeAtomic(join(dir, 'dev.vars'), devVars({ secrets: plan.secrets, port }));

  if (!process.argv.includes('--no-build')) {
    console.log('앱을 빌드하는 중입니다…');
    const build = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) return lock.release(), fail('빌드에 실패했습니다. 위의 메시지를 확인하세요.');
  }

  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...wranglerArgs({ port, dir })], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(dir, 'logs') },
  });
  const checking = new AbortController();
  child.on('exit', (code) => {
    checking.abort();
    lock.release();
    process.exit(failed ? 1 : stopping ? 0 : (code ?? 1));
  });

  const problem = await selfCheck(origin, checking.signal).catch(() => '서버 자체 점검에 실패했습니다. 서버를 중지합니다.');
  if (problem) {
    fail(problem);
    failed = true;
    child.kill('SIGTERM');
    return;
  }
  console.log(`\nStudyAI가 실행 중입니다: ${origin}`);
  console.log('처음이라면 위 주소에서 설정 → AI를 열고 "ChatGPT로 계속하기"를 누르세요. 이미 연결했다면 그대로 쓰면 됩니다.');
  console.log('localhost가 아니라 127.0.0.1 주소를 쓰세요. 끄려면 Ctrl+C를 누르세요.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
