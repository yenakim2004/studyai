import { timingSafeEqual } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { BRIDGE_FILE_MAX_BYTES, parsePairingRequest, sealConnection, type PairingRequest } from '../core/chatgpt/bridge';
import {
  authorizeUrl,
  CALLBACK_PATH,
  callbackClientId,
  completeSignIn,
  loopbackRedirectUri,
  newAttemptSecrets,
  OpenAiDirectory,
  parseCallbackQuery,
  revokeRefreshToken,
  type CallbackQuery,
  type IssuedClientId,
  type LoopbackRedirectUri,
  type OutboundFetch,
  type RefreshToken,
  type SignInFailure,
} from '../core/chatgpt/oauth';

/**
 * `studyai-connect <pairing.json> [--output <file>]`: signs in to ChatGPT on this computer for the user's own StudyAI Site,
 * then seals the grant to the Site's pairing key. It listens on 127.0.0.1 before showing the sign-in address, accepts one
 * callback with the matching state, writes only the sealed file, and never refreshes. The Site owns the tokens afterwards.
 */
export interface ConnectDeps {
  http: OutboundFetch;
  now: () => number;
  /** Shows the sign-in address. It is not secret; the browser receives it anyway. */
  presentAuthorizeUrl: (url: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  /** How long to wait for the browser. The request's own expiry also bounds it. */
  waitMs?: number;
}

const WAIT_MS = 10 * 60_000;
const MIN_LEFT_MS = 60_000;
const SIGN_IN_MS = 60_000;

export const CONNECT_HELP = `StudyAI ChatGPT 연결 도구

  studyai-connect <요청 파일.json> [--output <연결 파일.json>]

내 StudyAI Site 설정에서 내려받은 요청 파일로 이 컴퓨터에서 ChatGPT에 로그인하고,
그 Site만 열 수 있는 암호화된 연결 파일을 만듭니다. 연결 파일은 Site 설정에서 올리세요.
요청 파일은 반드시 본인 Site에서 직접 내려받은 것만 사용하세요. 인터넷 주소는 받지 않습니다.
`;

const TRUST = '이 요청 파일은 반드시 본인의 StudyAI Site 설정 화면에서 직접 내려받은 파일이어야 합니다. 다른 사람이 보낸 파일을 쓰면 그 사람이 내 ChatGPT 연결을 가져갈 수 있습니다.';

type Args = { kind: 'help' } | { kind: 'run'; request: string; output: string | null } | { kind: 'usage'; message: string };

function parseArgs(argv: string[]): Args {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return { kind: 'help' };
  const positional: string[] = [];
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--output') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { kind: 'usage', message: '--output 뒤에 연결 파일 경로를 적으세요.' };
      output = v;
    } else if (a.startsWith('-')) return { kind: 'usage', message: `알 수 없는 옵션입니다: ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { kind: 'usage', message: '요청 파일 하나를 지정하세요.' };
  const request = positional[0]!;
  if (/^[a-z][a-z0-9+.-]*:/i.test(request) && !/^[a-z]:[\\/]/i.test(request))
    return { kind: 'usage', message: '인터넷 주소는 받지 않습니다. 본인 Site에서 내려받은 요청 파일의 경로를 적으세요.' };
  return { kind: 'run', request, output };
}

async function readRequest(path: string): Promise<PairingRequest | 'missing' | 'invalid'> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return 'missing';
  }
  try {
    if (!(await fh.stat()).isFile()) return 'invalid';
    const buf = Buffer.alloc(BRIDGE_FILE_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > BRIDGE_FILE_MAX_BYTES) return 'invalid';
    return parsePairingRequest(buf.subarray(0, bytesRead).toString('utf8')) ?? 'invalid';
  } finally {
    await fh.close();
  }
}

async function keyIsUsable(jwk: JsonWebKey): Promise<boolean> {
  try {
    await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

const PAGE = {
  done: { status: 200, text: '연결 파일을 만들었습니다. 터미널 안내를 확인하고 이 창을 닫으세요.' },
  failed: { status: 200, text: '연결하지 못했습니다. 터미널 안내를 확인하세요.' },
  bad: { status: 400, text: '잘못된 요청입니다.' },
  used: { status: 409, text: '이미 처리된 로그인입니다.' },
  missing: { status: 404, text: '찾을 수 없습니다.' },
} as const;

function page(res: ServerResponse, p: (typeof PAGE)[keyof typeof PAGE]): void {
  res.writeHead(p.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    connection: 'close',
  });
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>StudyAI</title></head><body><p>${p.text}</p></body></html>`);
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Callback = { query: CallbackQuery; res: ServerResponse };

/**
 * One loopback listener for one attempt. Anything but `GET <callback path>` on the exact `127.0.0.1:<port>` Host, with the
 * attempt's state, is answered and ignored, so a stray or forged request cannot use up the attempt. The first matching
 * request claims it; every later one gets 409.
 */
async function listen(state: () => string): Promise<{ server: Server; redirectUri: LoopbackRedirectUri; callback: Promise<Callback> }> {
  let claimed = false;
  let deliver!: (c: Callback) => void;
  const callback = new Promise<Callback>((r) => (deliver = r));
  let port = 0;
  const server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000 }, (req: IncomingMessage, res) => {
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    if (req.method !== 'GET' || hasBody || req.headers.host !== `127.0.0.1:${port}` || !req.url?.startsWith('/')) return page(res, PAGE.bad);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== CALLBACK_PATH) return page(res, PAGE.missing);
    if (claimed) return page(res, PAGE.used);
    const query = parseCallbackQuery(url.searchParams);
    if (!query || !sameSecret(query.state, state())) return page(res, PAGE.bad);
    claimed = true;
    deliver({ query, res });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  port = (server.address() as AddressInfo).port;
  const redirectUri = loopbackRedirectUri(port);
  if (!redirectUri) throw new Error('loopback port out of range');
  return { server, redirectUri, callback };
}

function close(server: Server): Promise<void> {
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

function failureSentence(f: SignInFailure): string {
  switch (f.kind) {
    case 'plan-not-granted':
      return 'ChatGPT 플랜 사용이 허용되지 않았습니다. 플랜 사용을 허용하려면 Site 설정에서 새 요청 파일을 내려받아 다시 실행하세요.';
    case 'no-id-token':
    case 'identity':
      return f.kind === 'identity' && f.problem === 'keys-unavailable' ? 'OpenAI 로그인 확인 정보를 받지 못했습니다. 잠시 후 다시 시도하세요.' : '로그인 확인(ID 토큰 검증)에 실패했습니다.';
    case 'token':
      switch (f.failure.kind) {
        case 'code-rejected':
          return '로그인 코드가 거부되었습니다. 다시 실행하세요.';
        case 'invalid-client':
          return 'OpenAI가 이 앱 등록을 거부했습니다. Site 설정에서 연결을 지우고 새로 연결하세요.';
        case 'transient':
          return 'OpenAI에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';
        case 'rejected':
        case 'invalid-response':
          return 'OpenAI의 응답을 처리할 수 없었습니다.';
      }
  }
}

/**
 * A token issued here but not handed over. Revoking it is safe only for a new registration: a returning client may still
 * have a live session on the Site, and revoking one token of a client may end that client's other grants.
 */
async function dropToken(deps: ConnectDeps, request: PairingRequest, directory: OpenAiDirectory, clientId: IssuedClientId, token: RefreshToken): Promise<void> {
  if (request.client.kind !== 'dynamic') {
    deps.err('발급된 토큰은 저장하지 않았으며 사용되지 않은 채 만료됩니다.');
    return;
  }
  const r = await revokeRefreshToken(deps.http, directory, { clientId, refreshToken: token, signal: AbortSignal.timeout(SIGN_IN_MS) });
  deps.err(r === 'revoked' ? '발급된 토큰은 저장하지 않고 폐기했습니다.' : '발급된 토큰은 저장하지 않았습니다. 폐기 요청은 완료되지 않았습니다.');
}

async function writeExclusive(path: string, text: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, 'wx', 0o600);
  } catch {
    return false;
  }
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
    await fh.close();
    return true;
  } catch {
    await fh.close().catch(() => {});
    await unlink(path).catch(() => {});
    return false;
  }
}

export async function runConnect(argv: string[], deps: ConnectDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args.kind === 'help') {
    deps.out(CONNECT_HELP);
    return 0;
  }
  if (args.kind === 'usage') {
    deps.err(`${args.message}\n\n${CONNECT_HELP}`);
    return 2;
  }

  const requestPath = resolve(deps.cwd, args.request);
  const request = await readRequest(requestPath);
  if (request === 'missing') {
    deps.err('요청 파일을 열 수 없습니다. 경로를 확인하세요.');
    return 1;
  }
  if (request === 'invalid' || !(await keyIsUsable(request.publicKey))) {
    deps.err('StudyAI 요청 파일이 아니거나 손상되었습니다. Site 설정에서 요청 파일을 다시 내려받으세요.');
    return 1;
  }
  if (request.expiresAt - deps.now() < MIN_LEFT_MS) {
    deps.err('요청 파일이 만료되었거나 곧 만료됩니다. Site 설정에서 새 요청 파일을 내려받으세요.');
    return 1;
  }
  const outputPath = args.output ? resolve(deps.cwd, args.output) : resolve(dirname(requestPath), `studyai-connection-${request.pairingId.slice(0, 8)}.json`);
  if (await exists(outputPath)) {
    deps.err(`이미 같은 이름의 파일이 있어 덮어쓰지 않습니다: ${outputPath}`);
    return 1;
  }
  if (!(await stat(dirname(outputPath)).then((s) => s.isDirectory(), () => false))) {
    deps.err(`연결 파일을 저장할 폴더가 없습니다: ${dirname(outputPath)}`);
    return 1;
  }

  const secrets = { ...newAttemptSecrets(), nonce: request.nonce };
  const { server, redirectUri, callback } = await listen(() => secrets.state);
  const deadline = Math.min(deps.now() + (deps.waitMs ?? WAIT_MS), request.expiresAt - MIN_LEFT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await authorizeUrl({ client: request.client, hostId: request.hostId, redirectUri, secrets, forceConsent: request.forceConsent });
    deps.out(TRUST);
    if (request.client.kind === 'issued' && request.client.loginHint) deps.out(`다시 연결할 계정: ${request.client.loginHint}`);
    deps.out('이 컴퓨터의 브라우저에서 아래 주소를 열어 ChatGPT에 로그인하세요.');
    deps.presentAuthorizeUrl(url);
    deps.out(`로그인을 기다리는 중입니다. ${clock(deadline)}까지 완료하세요.`);

    const timedOut = new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.max(0, deadline - deps.now()))));
    const got = await Promise.race([callback, timedOut]);
    if (!got) {
      deps.err('제한 시간 안에 로그인이 끝나지 않았습니다. Site 설정에서 새 요청 파일을 내려받아 다시 실행하세요.');
      return 1;
    }
    const { query, res } = got;
    const fail = (sentence: string): number => {
      page(res, PAGE.failed);
      deps.err(sentence);
      return 1;
    };
    if (query.kind === 'error') return fail(query.error === 'access_denied' ? '로그인이 취소되었습니다.' : 'OpenAI가 로그인을 완료하지 않았습니다.');
    const clientId = callbackClientId(request.client, query.clientId);
    if (!clientId) return fail(request.client.kind === 'dynamic' ? 'OpenAI 앱 등록이 완료되지 않았습니다. 다시 실행하세요.' : '다른 앱 등록으로 로그인이 돌아왔습니다. Site 설정에서 새 요청 파일을 내려받으세요.');

    const directory = new OpenAiDirectory({ http: deps.http, now: deps.now });
    const done = await completeSignIn(deps.http, directory, {
      clientId,
      code: query.code,
      verifier: secrets.verifier,
      redirectUri,
      nonce: request.nonce,
      now: deps.now(),
      signal: AbortSignal.timeout(SIGN_IN_MS),
    });
    if (!done.ok) {
      const code = fail(failureSentence(done.failure));
      if (done.orphan) await dropToken(deps, request, directory, clientId, done.orphan);
      return code;
    }

    const expiresInS = Math.floor((done.grant.expiresAt - deps.now()) / 1000);
    const text = expiresInS >= 1
      ? await sealConnection(request, {
          clientId: done.clientId,
          idToken: done.idToken,
          accessToken: done.grant.accessToken,
          refreshToken: done.grant.refreshToken,
          expiresInS,
          earliestRefreshAt: done.grant.earliestRefreshAt,
          scopes: [...done.grant.scopes],
        }).then(
          (sealed) => `${JSON.stringify(sealed)}\n`,
          () => null,
        )
      : null;
    if (text === null || Buffer.byteLength(text) > BRIDGE_FILE_MAX_BYTES) {
      const code = fail('OpenAI가 준 연결 정보를 연결 파일에 담을 수 없었습니다.');
      await dropToken(deps, request, directory, done.clientId, done.grant.refreshToken);
      return code;
    }
    if (!(await writeExclusive(outputPath, text))) {
      const code = fail(`연결 파일을 저장하지 못했습니다(기존 파일은 덮어쓰지 않습니다): ${outputPath}\nSite 설정에서 새 요청 파일을 내려받아 다시 실행하세요.`);
      await dropToken(deps, request, directory, done.clientId, done.grant.refreshToken);
      return code;
    }
    page(res, PAGE.done);
    deps.out(`연결 파일을 만들었습니다: ${outputPath}`);
    deps.out(`StudyAI Site 설정에서 이 파일을 ${clock(request.expiresAt)} 전에 올리세요. 이 파일은 요청을 만든 Site에서만 열 수 있습니다. 올린 뒤에는 지워도 됩니다.`);
    return 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await close(server);
  }
}
