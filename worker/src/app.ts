import { AiTaskSchema, type AiReply, type AiStatus, type AiTask, type SignInOutcome } from '../../src/core/tutor/contract';
import { CALLBACK_PATH, parseCallbackQuery, type CallbackQuery } from '../../src/core/chatgpt/oauth';
import { CHATGPT_REPLY, isChatGptCode, START_REFUSAL } from '../../src/core/chatgpt/messages';
import type { DisconnectReply, ModelsReply, SelectReply, StartOptions, StartReply } from './chatgpt';
import { callbackHeaders, callbackPage, isLoopbackRequest, localRequestProblem, type Loopback } from './loopback';

/**
 * Request handling for /api/* and the OAuth callback, free of any Cloudflare runtime import so it can be tested in Node with
 * a fake backend. The Durable Object (do.ts) implements `Backend` and holds the ChatGPT account.
 */

export type Ok = { ok: true };
export type Failure = { ok: false; code: string; message: string };

export interface Backend {
  askTask(task: AiTask): Promise<AiReply>;
  status(): Promise<AiStatus>;
  chatgptStart(o: StartOptions): Promise<StartReply>;
  chatgptCallback(q: CallbackQuery): Promise<SignInOutcome>;
  chatgptDisconnect(forget: boolean): Promise<DisconnectReply>;
  chatgptModels(): Promise<ModelsReply>;
  chatgptResume(): Promise<Ok>;
  chatgptSelectModel(model: string): Promise<SelectReply>;
}

export interface AppEnv {
  backend: Backend;
  /** Set only under the local launcher (worker/src/loopback.ts). Null for every hosted copy, which then has no AI at all. */
  loopback: Loopback | null;
}

const MAX_BODY = 262_144;

const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
};

/** Every refusal the API itself gives, before or around the ChatGPT account. ChatGPT's own codes live in messages.ts. */
export const APP_REPLY = {
  'method-not-allowed': { status: 405, message: '이 주소는 GET과 POST 요청만 받습니다.' },
  'local-only': { status: 404, message: 'AI 기능은 내 컴퓨터에서 pnpm local로 실행한 StudyAI에서만 쓸 수 있습니다. 이 사본에서는 AI 없이 공부 기능만 쓸 수 있습니다.' },
  'wrong-host': { status: 421, message: 'StudyAI를 실행할 때 안내된 http://127.0.0.1 주소로 열어 주세요.' },
  'cross-site': { status: 403, message: '다른 사이트나 다른 주소에서 보낸 요청은 받지 않습니다.' },
  'expected-json': { status: 415, message: 'JSON 형식의 요청만 받습니다.' },
  'too-large': { status: 413, message: '요청이 너무 큽니다.' },
  'invalid-json': { status: 400, message: '요청 내용을 읽을 수 없습니다.' },
  'invalid-request': { status: 400, message: '요청 형식이 올바르지 않습니다.' },
  'invalid-model': { status: 400, message: '이 계정의 모델 목록에 없는 모델입니다.' },
  'not-found': { status: 404, message: '없는 API 주소입니다.' },
  'server-error': { status: 500, message: 'StudyAI 서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도하세요.' },
} as const satisfies Record<string, { status: number; message: string }>;
export type AppCode = keyof typeof APP_REPLY;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extra } });
}

function refuse(code: AppCode, message: string = APP_REPLY[code].message): Response {
  return json({ ok: false, code, message } satisfies Failure, APP_REPLY[code].status, code === 'method-not-allowed' ? { allow: 'GET, POST' } : {});
}

/** The HTTP status of a reply code. ChatGPT codes come from their one table; anything unknown is a 500. */
export function statusForCode(code: string): number {
  if (isChatGptCode(code)) return CHATGPT_REPLY[code].status;
  return Object.hasOwn(APP_REPLY, code) ? APP_REPLY[code as AppCode].status : 500;
}

/** Reads the body as a stream and stops as soon as it exceeds the cap, whatever Content-Length claims (or omits). */
async function readCapped(request: Request, max = MAX_BODY): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** JSON only: a cross-site page cannot send this content type without a preflight, and the API answers no preflight. */
async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json(;|$)/i.test(type)) return { ok: false, response: refuse('expected-json') };
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY) return { ok: false, response: refuse('too-large') };
  const bytes = await readCapped(request);
  if (!bytes) return { ok: false, response: refuse('too-large') };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: refuse('invalid-json') };
  }
}

/** The callback is matched before anything else: it ends a cross-site redirect chain and authenticates by its single-use state. */
export async function route(request: Request, env: AppEnv, serveAsset: (request: Request) => Promise<Response>): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === CALLBACK_PATH) return handleOAuthCallback(request, env);
  if (path.startsWith('/api/')) return handle(request, env);
  return serveAsset(request);
}

const plain = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });

/** Loopback only, GET only, exact host. A query that is not a callback answers the fixed "unknown attempt" page untouched. */
export async function handleOAuthCallback(request: Request, env: AppEnv): Promise<Response> {
  if (!env.loopback) return plain(404, '찾을 수 없습니다.');
  if (request.method.toUpperCase() !== 'GET') return new Response('GET 요청만 받습니다.', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  if (!isLoopbackRequest(request, env.loopback)) return plain(421, APP_REPLY['wrong-host'].message);
  const url = new URL(request.url);
  const query = url.href.length <= 8_192 ? parseCallbackQuery(url.searchParams) : null;
  let outcome: SignInOutcome = 'unknown-attempt';
  if (query) {
    try {
      outcome = await env.backend.chatgptCallback(query);
    } catch {
      outcome = 'upstream-unavailable';
    }
  }
  return new Response(callbackPage(outcome), { status: 200, headers: await callbackHeaders() });
}

/** Only our own Korean sentences go back: a schema's built-in issue text is English and says nothing useful to a student. */
function invalidTask(issues: readonly { code: string; message: string }[]): Response {
  const own = issues.find((i) => i.code === 'custom')?.message;
  return refuse('invalid-request', own ?? APP_REPLY['invalid-request'].message);
}

export async function handle(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method !== 'GET' && method !== 'POST') return refuse('method-not-allowed');
  if (path === '/api/health' && method === 'GET') return json({ service: 'studyai', ok: true });
  // A hosted copy answers before the Durable Object is ever addressed, so the account behind it cannot be reached from there.
  if (!env.loopback) return refuse('local-only');
  const problem = localRequestProblem(request, env.loopback);
  if (problem) return refuse(problem);

  try {
    if (method === 'GET') {
      if (path === '/api/status') return json(await env.backend.status());
      if (path === '/api/chatgpt/models') {
        const r = await env.backend.chatgptModels();
        return r.ok ? json(r) : json({ ok: false, code: r.code, message: r.message } satisfies Failure, CHATGPT_REPLY[r.code].status);
      }
      return refuse('not-found');
    }

    const body = await readJson(request);
    if (!body.ok) return body.response;
    const v = body.value;

    if (path === '/api/ai/ask') {
      const task = AiTaskSchema.safeParse(v);
      if (!task.success) return invalidTask(task.error.issues);
      const reply = await env.backend.askTask(task.data);
      return json(reply, reply.ok ? 200 : statusForCode(reply.code));
    }

    const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    if (!o) return refuse('invalid-request');
    switch (path) {
      case '/api/chatgpt/start': {
        if ((o['account'] !== undefined && o['account'] !== 'current' && o['account'] !== 'other') || (o['forceConsent'] !== undefined && typeof o['forceConsent'] !== 'boolean')) return refuse('invalid-request');
        const r = await env.backend.chatgptStart({ account: o['account'] === 'other' ? 'other' : 'current', forceConsent: o['forceConsent'] === true });
        return r.ok ? json(r) : json({ ok: false, code: r.error, message: START_REFUSAL[r.error] } satisfies Failure, r.error === 'superseded' ? 409 : 403);
      }
      case '/api/chatgpt/disconnect':
        if (o['forget'] !== undefined && typeof o['forget'] !== 'boolean') return refuse('invalid-request');
        return json(await env.backend.chatgptDisconnect(o['forget'] === true));
      case '/api/chatgpt/resume':
        return json(await env.backend.chatgptResume());
      case '/api/chatgpt/model': {
        if (typeof o['model'] !== 'string' || o['model'].length > 200) return refuse('invalid-request');
        const r = await env.backend.chatgptSelectModel(o['model']);
        return r.ok ? json(r) : refuse('invalid-model', r.error);
      }
      default:
        return refuse('not-found');
    }
  } catch {
    // Never echo internals. The details are not logged either: they could contain request content.
    return refuse('server-error');
  }
}
