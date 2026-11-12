import { z } from 'zod';
import type { AiRequest } from '../ai/request';
import { type AccessToken, Deadlines, isRedirect, type OutboundFetch, parseJson, readCapped, requestIdOf, sendBounded, upstreamCode } from './oauth';

/**
 * Inference on the user's ChatGPT plan through the public Responses API, and the plan's model list. Runtime-neutral. The
 * body sent is exactly { model, instructions?, input, store: false, stream: true }: the docs list `temperature` and
 * `max_output_tokens` as unsupported on this route, and `previous_response_id` would need stored responses. Only
 * `response.completed` is success. Anything else discards the partial text and returns a typed failure. Nothing is
 * retried here, since each request counts against the user's plan.
 */

export const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const MODELS_URL = 'https://api.openai.com/v1/models';

const ERROR_BODY_BYTES = 16 * 1024;
const MODELS_BODY_BYTES = 1024 * 1024;
const MODELS_TIMEOUT_MS = 15_000;
const MAX_MODELS = 100;

const ModelSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => s.trim() === s)
  .brand<'ModelSlug'>();
/** A model id as the plan's model list returns it (`slug`). */
export type ModelSlug = z.infer<typeof ModelSlugSchema>;
export const parseModelSlug = (raw: unknown): ModelSlug | null => {
  const r = ModelSlugSchema.safeParse(raw);
  return r.success ? r.data : null;
};

export interface ModelOption {
  slug: ModelSlug;
  displayName: string;
}

export interface StreamTiming {
  /** Response headers must arrive within this. */
  headersMs: number;
  /** Longest silence between two body chunks. */
  idleMs: number;
  /** Whole request, from fetch to the terminal event. */
  totalMs: number;
  /** Answer text above this many characters stops the read. */
  maxTextChars: number;
  /**
   * Largest single event, counting an unfinished line. `response.completed` repeats the whole answer, possibly with every
   * non-ASCII character escaped as six characters, so this sits well above maxTextChars.
   */
  maxEventChars: number;
}

export const DEFAULT_STREAM_TIMING: StreamTiming = { headersMs: 30_000, idleMs: 60_000, totalMs: 170_000, maxTextChars: 200_000, maxEventChars: 4_000_000 };

/** Why a response did not complete. Upstream codes survive only as slugs; no upstream text, `detail` or message is kept. */
export type ResponsesFailure =
  /** 401 before the stream, or `subscription_sharing_invalid_user`. Confirm with a refresh before asking to sign in again. */
  | { kind: 'auth' }
  | { kind: 'not-eligible' }
  /** Another 403: region policy, `chatpass_v2_*`, `subscription_sharing_route_not_supported`. */
  | { kind: 'forbidden'; upstreamCode: string | null }
  /** `subscription_sharing_usage_limit_exceeded`, before or during the stream. No reset time can be inferred from it. */
  | { kind: 'usage-limit' }
  /** Any other 429. */
  | { kind: 'rate-limited' }
  /** 5xx, `subscription_sharing_usage_unavailable` or `subscription_sharing_user_unavailable`. Credentials stay valid. */
  | { kind: 'unavailable' }
  /** `subscription_sharing_unsupported_capability`. The body is built here, so this is our bug; `param` says what. */
  | { kind: 'unsupported'; param: string | null }
  | { kind: 'rejected'; status: number; upstreamCode: string | null }
  /** `response.failed` or an `error` event with another code. */
  | { kind: 'failed'; upstreamCode: string | null }
  /** `response.incomplete`: terminal, but not success. */
  | { kind: 'incomplete'; reason: string | null }
  /** The stream ended, or sent an unreadable event, before a terminal event. */
  | { kind: 'interrupted' }
  /** A 2xx model list we cannot read. */
  | { kind: 'invalid-response' }
  | { kind: 'too-large' }
  | { kind: 'timeout' }
  /** The caller's signal: disconnect, replacement or a closed request. */
  | { kind: 'aborted' }
  | { kind: 'network' }
  | { kind: 'redirect' };

export type StreamOutcome = { ok: true; text: string; requestId: string | null } | { ok: false; failure: ResponsesFailure; requestId: string | null };

const BY_CODE: ReadonlyMap<string, (param: string | null) => ResponsesFailure> = new Map<string, (param: string | null) => ResponsesFailure>([
  ['subscription_sharing_usage_limit_exceeded', () => ({ kind: 'usage-limit' })],
  ['subscription_sharing_user_not_eligible', () => ({ kind: 'not-eligible' })],
  ['subscription_sharing_invalid_user', () => ({ kind: 'auth' })],
  ['subscription_sharing_usage_unavailable', () => ({ kind: 'unavailable' })],
  ['subscription_sharing_user_unavailable', () => ({ kind: 'unavailable' })],
  ['subscription_sharing_unsupported_capability', (param) => ({ kind: 'unsupported', param })],
  ['subscription_sharing_route_not_supported', () => ({ kind: 'forbidden', upstreamCode: 'subscription_sharing_route_not_supported' })],
]);

function failureForCode(code: string | null, param: string | null): ResponsesFailure | null {
  if (code === null) return null;
  const known = BY_CODE.get(code);
  if (known) return known(param);
  return code.startsWith('chatpass_v2_') ? { kind: 'forbidden', upstreamCode: code } : null;
}

const safeParam = (raw: unknown): string | null => (typeof raw === 'string' && /^[A-Za-z0-9_.[\]-]{1,80}$/.test(raw) ? raw : null);

const ErrorBodySchema = z.object({ error: z.object({ code: z.unknown().optional(), param: z.unknown().optional() }) });

/** A non-2xx answer. `{ detail }` bodies carry no stable code (docs), so only the status speaks for them. */
function httpFailure(status: number, json: unknown): ResponsesFailure {
  const body = ErrorBodySchema.safeParse(json);
  const code = body.success ? upstreamCode(body.data.error.code) : null;
  const known = failureForCode(code, body.success ? safeParam(body.data.error.param) : null);
  if (known) return known;
  if (status === 401) return { kind: 'auth' };
  if (status === 403) return { kind: 'forbidden', upstreamCode: code };
  if (status === 429) return { kind: 'rate-limited' };
  if (status >= 500) return { kind: 'unavailable' };
  return { kind: 'rejected', status, upstreamCode: code };
}

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE framing (WHATWG). UTF-8 decoded in stream mode, so a character split across chunks survives. Lines end
 * at CRLF, LF or CR, also when the CR and LF arrive in different chunks. Comments and unknown fields are ignored, data
 * lines join with '\n', and an event without a closing blank line is dropped at EOF. `push` and `end` return 'too-large'
 * once the unfinished line plus the event being built exceed the limit.
 */
class SseDecoder {
  readonly #decoder = new TextDecoder();
  readonly #maxChars: number;
  #line = '';
  #afterCR = false;
  #data: string[] = [];
  #dataChars = 0;
  #event = '';

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  push(bytes: Uint8Array): SseEvent[] | 'too-large' {
    return this.#feed(this.#decoder.decode(bytes, { stream: true }));
  }

  end(): SseEvent[] | 'too-large' {
    return this.#feed(this.#decoder.decode());
  }

  #feed(text: string): SseEvent[] | 'too-large' {
    const out: SseEvent[] = [];
    let i = 0;
    if (this.#afterCR && text.length > 0) {
      if (text[0] === '\n') i = 1;
      this.#afterCR = false;
    }
    const eol = /[\r\n]/g;
    while (i < text.length) {
      eol.lastIndex = i;
      const m = eol.exec(text);
      if (!m) {
        this.#line += text.slice(i);
        break;
      }
      const line = this.#line + text.slice(i, m.index);
      this.#line = '';
      i = m.index + 1;
      if (m[0] === '\r') {
        if (i < text.length) {
          if (text[i] === '\n') i += 1;
        } else this.#afterCR = true;
      }
      this.#onLine(line, out);
      if (this.#dataChars > this.#maxChars) return 'too-large';
    }
    return this.#line.length + this.#dataChars > this.#maxChars ? 'too-large' : out;
  }

  #onLine(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.#data.length > 0) out.push({ event: this.#event || 'message', data: this.#data.join('\n') });
      this.#data = [];
      this.#dataChars = 0;
      this.#event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.#data.push(value);
      this.#dataChars += value.length + 1;
    } else if (field === 'event') this.#event = value;
  }
}

const StreamEventSchema = z.object({ type: z.string() });
const DeltaSchema = z.object({ delta: z.string() });
const FailedSchema = z.object({ response: z.object({ error: z.object({ code: z.unknown().optional() }).nullish() }) });
const IncompleteSchema = z.object({ response: z.object({ incomplete_details: z.object({ reason: z.unknown().optional() }).nullish() }) });
const ErrorEventSchema = z.object({ code: z.unknown().optional(), param: z.unknown().optional(), error: z.object({ code: z.unknown().optional(), param: z.unknown().optional() }).nullish() });

type Step = { kind: 'delta'; text: string } | { kind: 'ignore' } | { kind: 'completed' } | { kind: 'failure'; failure: ResponsesFailure };

function readEvent(ev: SseEvent): Step {
  if (ev.data === '[DONE]') return { kind: 'ignore' };
  const json = parseJson(ev.data);
  if (json === undefined) return { kind: 'failure', failure: { kind: 'interrupted' } };
  const typed = StreamEventSchema.safeParse(json);
  const type = typed.success ? typed.data.type : ev.event;
  switch (type) {
    case 'response.output_text.delta': {
      const d = DeltaSchema.safeParse(json);
      return d.success ? { kind: 'delta', text: d.data.delta } : { kind: 'failure', failure: { kind: 'interrupted' } };
    }
    case 'response.completed':
      return { kind: 'completed' };
    case 'response.failed': {
      const f = FailedSchema.safeParse(json);
      const code = f.success ? upstreamCode(f.data.response.error?.code) : null;
      return { kind: 'failure', failure: failureForCode(code, null) ?? { kind: 'failed', upstreamCode: code } };
    }
    case 'response.incomplete': {
      const f = IncompleteSchema.safeParse(json);
      return { kind: 'failure', failure: { kind: 'incomplete', reason: f.success ? upstreamCode(f.data.response.incomplete_details?.reason) : null } };
    }
    case 'error': {
      const f = ErrorEventSchema.safeParse(json);
      const code = f.success ? upstreamCode(f.data.code ?? f.data.error?.code) : null;
      const param = f.success ? safeParam(f.data.param ?? f.data.error?.param) : null;
      return { kind: 'failure', failure: failureForCode(code, param) ?? { kind: 'failed', upstreamCode: code } };
    }
    default:
      return { kind: 'ignore' };
  }
}

export interface PlanRequest {
  token: AccessToken;
  model: ModelSlug;
  /** Only the conversation is read. `maxOutputTokens` and `temperature` are not accepted by this route and never sent. */
  request: Pick<AiRequest, 'system' | 'messages'>;
  signal: AbortSignal;
  timing?: StreamTiming;
}

const cutFailure = (reason: 'timeout' | 'aborted' | null): ResponsesFailure => (reason ? { kind: reason } : { kind: 'network' });

/**
 * POST /v1/responses with the bearer token, no organization or project header, and no retry. Header, idle and total
 * deadlines cover the fetch and every body read. Every exit clears its timers and cancels the body.
 */
export async function streamResponse(http: OutboundFetch, a: PlanRequest): Promise<StreamOutcome> {
  const timing = a.timing ?? DEFAULT_STREAM_TIMING;
  const body = {
    model: a.model,
    ...(a.request.system ? { instructions: a.request.system } : {}),
    input: a.request.messages.map((m) => ({ role: m.role, content: m.content })),
    store: false,
    stream: true,
  };
  const deadlines = new Deadlines(a.signal);
  deadlines.arm('total', timing.totalMs);
  deadlines.arm('headers', timing.headersMs);
  let requestId: string | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const fail = (failure: ResponsesFailure): StreamOutcome => ({ ok: false, failure, requestId });
  try {
    if (deadlines.reason) return fail(cutFailure(deadlines.reason));
    const res = await deadlines.race(
      http(RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: deadlines.signal,
        redirect: 'manual',
      }),
    );
    deadlines.disarm('headers');
    deadlines.arm('idle', timing.idleMs);
    requestId = requestIdOf(res);
    if (isRedirect(res)) {
      res.body?.cancel().catch(() => {});
      return fail({ kind: 'redirect' });
    }
    if (!res.ok) {
      const text = await readCapped(res, ERROR_BODY_BYTES, deadlines);
      return fail(httpFailure(res.status, text === null ? undefined : parseJson(text)));
    }
    if (!res.body) return fail({ kind: 'interrupted' });
    reader = res.body.getReader();
    const sse = new SseDecoder(timing.maxEventChars);
    const parts: string[] = [];
    let chars = 0;
    for (;;) {
      const { done, value } = await deadlines.race(reader.read());
      deadlines.arm('idle', timing.idleMs);
      const events = done ? sse.end() : sse.push(value);
      if (events === 'too-large') return fail({ kind: 'too-large' });
      for (const ev of events) {
        const step = readEvent(ev);
        if (step.kind === 'completed') {
          const text = parts.join('');
          return text.trim() ? { ok: true, text, requestId } : fail({ kind: 'failed', upstreamCode: null });
        }
        if (step.kind === 'failure') return fail(step.failure);
        if (step.kind === 'delta') {
          chars += step.text.length;
          if (chars > timing.maxTextChars) return fail({ kind: 'too-large' });
          parts.push(step.text);
        }
      }
      if (done) return fail({ kind: 'interrupted' });
    }
  } catch {
    return fail(cutFailure(deadlines.reason));
  } finally {
    deadlines.release();
    reader?.cancel().catch(() => {});
  }
}

const ModelListSchema = z.object({ models: z.array(z.unknown()) });
const ModelEntrySchema = z.object({ slug: ModelSlugSchema, display_name: z.string().trim().min(1).max(200), visibility: z.literal('list') });

/** GET /v1/models. Keeps `models[]` entries with visibility "list", in server order, at most 100, skipping unreadable ones. */
export async function listModels(
  http: OutboundFetch,
  a: { token: AccessToken; signal: AbortSignal },
): Promise<{ ok: true; models: ModelOption[]; requestId: string | null } | { ok: false; failure: ResponsesFailure; requestId: string | null }> {
  const r = await sendBounded(
    http,
    { url: MODELS_URL, method: 'GET', headers: { authorization: `Bearer ${a.token}`, accept: 'application/json' } },
    { signal: a.signal, timeoutMs: MODELS_TIMEOUT_MS, maxBytes: MODELS_BODY_BYTES },
  );
  if (r.kind === 'cut') return { ok: false, failure: { kind: r.reason }, requestId: null };
  if (r.kind !== 'response') return { ok: false, failure: { kind: r.kind }, requestId: null };
  const json = parseJson(r.text);
  if (r.status < 200 || r.status >= 300) return { ok: false, failure: httpFailure(r.status, json), requestId: r.requestId };
  const list = ModelListSchema.safeParse(json);
  if (!list.success) return { ok: false, failure: { kind: 'invalid-response' }, requestId: r.requestId };
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of list.data.models) {
    const m = ModelEntrySchema.safeParse(raw);
    if (!m.success || seen.has(m.data.slug)) continue;
    seen.add(m.data.slug);
    models.push({ slug: m.data.slug, displayName: m.data.display_name });
    if (models.length === MAX_MODELS) break;
  }
  return { ok: true, models, requestId: r.requestId };
}
