import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAccessToken, type OutboundFetch, type OutboundInit } from '../src/core/chatgpt/oauth';
import { DEFAULT_STREAM_TIMING, listModels, parseModelSlug, streamResponse, type StreamTiming } from '../src/core/chatgpt/responses';

afterEach(() => vi.useRealTimers());

const RESPONSES = 'https://api.openai.com/v1/responses';
const MODELS = 'https://api.openai.com/v1/models';
const TOKEN = parseAccessToken('at-1')!;
const MODEL = parseModelSlug('gpt-test-1')!;
const REQUEST = { system: '너는 튜터야.', messages: [{ role: 'user' as const, content: '질문' }, { role: 'assistant' as const, content: '답' }, { role: 'user' as const, content: '다시' }] };
const enc = new TextEncoder();

interface Body {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
}
function body(chunks: (string | Uint8Array)[], o: { hang?: boolean; delayMs?: number; fail?: boolean } = {}): Body {
  let i = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull: async (ctl) => {
      if (o.delayMs) await new Promise<void>((r) => (timer = setTimeout(r, o.delayMs)));
      if (i < chunks.length) {
        const c = chunks[i++]!;
        ctl.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      } else if (o.fail) ctl.error(new TypeError('connection reset'));
      else if (o.hang) await new Promise(() => {});
      else ctl.close();
    },
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
    },
  });
  return { stream, cancelled: () => cancelled };
}

function upstream(answer: (init: OutboundInit) => Response | Promise<Response>) {
  const calls: { url: string; init: OutboundInit }[] = [];
  const http: OutboundFetch = async (url, init) => {
    calls.push({ url, init });
    return answer(init);
  };
  return { http, calls };
}
const sse = (b: Body, headers: Record<string, string> = {}) => new Response(b.stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
const ev = (data: unknown, name?: string, eol = '\n') => `${name ? `event: ${name}${eol}` : ''}data: ${JSON.stringify(data)}${eol}${eol}`;
const delta = (text: string, eol?: string) => ev({ type: 'response.output_text.delta', delta: text }, 'response.output_text.delta', eol);
const completed = (eol?: string) => ev({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }, 'response.completed', eol);

const run = (chunks: (string | Uint8Array)[], o: { timing?: Partial<StreamTiming>; signal?: AbortSignal; hang?: boolean; delayMs?: number; fail?: boolean; headers?: Record<string, string> } = {}) => {
  const b = body(chunks, o);
  const up = upstream(() => sse(b, o.headers));
  const outcome = streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: o.signal ?? new AbortController().signal, timing: { ...DEFAULT_STREAM_TIMING, ...o.timing } });
  return { outcome, up, b };
};

describe('the request', () => {
  it('sends exactly model, instructions, input, store:false and stream:true to the fixed endpoint', async () => {
    const { outcome, up } = run([completed()]);
    await outcome;
    expect(up.calls).toHaveLength(1);
    const { url, init } = up.calls[0]!;
    expect(url).toBe(RESPONSES);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ authorization: 'Bearer at-1', 'content-type': 'application/json', accept: 'text/event-stream' });
    expect(JSON.parse(init.body!)).toEqual({
      model: 'gpt-test-1',
      instructions: '너는 튜터야.',
      input: [
        { role: 'user', content: '질문' },
        { role: 'assistant', content: '답' },
        { role: 'user', content: '다시' },
      ],
      store: false,
      stream: true,
    });
  });

  it('drops settings the route does not accept and leaves out instructions when there is no system prompt', async () => {
    const b = body([completed()]);
    const up = upstream(() => sse(b));
    const withExtras = { model: 'other-model', purpose: 'tutor', maxOutputTokens: 900, temperature: 0.2, messages: [{ role: 'user' as const, content: 'hi' }] };
    await streamResponse(up.http, { token: TOKEN, model: MODEL, request: withExtras, signal: new AbortController().signal });
    expect(JSON.parse(up.calls[0]!.init.body!)).toEqual({ model: 'gpt-test-1', input: [{ role: 'user', content: 'hi' }], store: false, stream: true });
  });
});

describe('reading the stream', () => {
  const fixture = `: keep-alive\n\n${delta('안녕')}${delta('하세요 ✓')}event: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"!"}\n\n${ev({ type: 'response.output_text.done', text: 'ignored' })}${completed()}`;

  it('joins deltas into the answer once response.completed arrives, and keeps the request id', async () => {
    const { outcome } = run([fixture], { headers: { 'x-request-id': 'req_abc' } });
    expect(await outcome).toEqual({ ok: true, text: '안녕하세요 ✓!', requestId: 'req_abc' });
  });

  it('does not report refusals or empty completions as successful answers', async () => {
    for (const chunks of [[completed()], [delta(' \n\t'), completed()], [ev({ type: 'response.refusal.delta', delta: 'refused' }), completed()]]) {
      const { outcome, b } = run(chunks, { hang: true });
      expect(await outcome).toEqual({ ok: false, failure: { kind: 'failed', upstreamCode: null }, requestId: null });
      expect(b.cancelled()).toBe(true);
    }
  });

  it('gives the same answer however the bytes are split, including inside a Korean character and a CRLF', async () => {
    const crlf = fixture.replace(/\n/g, '\r\n');
    for (const text of [fixture, crlf, fixture.replace(/\n/g, '\r')]) {
      const bytes = enc.encode(text);
      for (let at = 1; at < bytes.length; at++) {
        const { outcome } = run([bytes.slice(0, at), bytes.slice(at)]);
        expect(await outcome, `split at ${at}`).toEqual({ ok: true, text: '안녕하세요 ✓!', requestId: null });
      }
      const { outcome } = run([...bytes].map((b) => new Uint8Array([b])));
      expect(await outcome).toMatchObject({ ok: true, text: '안녕하세요 ✓!' });
    }
  });

  it('discards partial text when the answer fails after deltas', async () => {
    const usage = await run([delta('부분 '), ev({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'echoed user text' } } })]).outcome;
    expect(usage).toEqual({ ok: false, failure: { kind: 'usage-limit' }, requestId: null });
    expect(JSON.stringify(usage)).not.toContain('부분');
    expect(JSON.stringify(usage)).not.toContain('echoed');
    expect(await run([delta('a'), ev({ type: 'response.failed', response: { error: { code: 'server_error' } } })]).outcome).toMatchObject({ ok: false, failure: { kind: 'failed', upstreamCode: 'server_error' } });
    expect(await run([ev({ type: 'response.failed', response: { error: null } })]).outcome).toMatchObject({ ok: false, failure: { kind: 'failed', upstreamCode: null } });
  });

  it('treats response.incomplete as a failure with its reason', async () => {
    expect(await run([delta('cut'), ev({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })]).outcome).toEqual({
      ok: false,
      failure: { kind: 'incomplete', reason: 'max_output_tokens' },
      requestId: null,
    });
  });

  it('classifies an error event by its code', async () => {
    expect(await run([ev({ type: 'error', code: 'subscription_sharing_usage_unavailable', message: 'x' })]).outcome).toMatchObject({ failure: { kind: 'unavailable' } });
    expect(await run([ev({ type: 'error', error: { code: 'subscription_sharing_unsupported_capability', param: 'tools' } })]).outcome).toMatchObject({ failure: { kind: 'unsupported', param: 'tools' } });
    expect(await run([ev({ type: 'error', code: 'Some Free Text' })]).outcome).toMatchObject({ failure: { kind: 'failed', upstreamCode: null } });
  });

  it('calls it interrupted when the stream ends without a terminal event', async () => {
    expect(await run([delta('a')]).outcome).toEqual({ ok: false, failure: { kind: 'interrupted' }, requestId: null });
    expect(await run([delta('a'), 'data: [DONE]\n\n']).outcome).toMatchObject({ failure: { kind: 'interrupted' } });
    expect(await run([delta('a'), completed().trimEnd()]).outcome).toMatchObject({ failure: { kind: 'interrupted' } });
    expect(await run([delta('a'), 'data: {not json\n\n', completed()]).outcome).toMatchObject({ failure: { kind: 'interrupted' } });
    expect(await run([ev({ type: 'response.output_text.delta', delta: 5 }), completed()]).outcome).toMatchObject({ failure: { kind: 'interrupted' } });
  });

  it('stops reading at the terminal event and cancels the body', async () => {
    const { outcome, b } = run([delta('a'), completed()], { hang: true });
    expect(await outcome).toMatchObject({ ok: true, text: 'a' });
    expect(b.cancelled()).toBe(true);
  });

  it('reports a dropped connection as a network failure', async () => {
    expect(await run([delta('a')], { fail: true }).outcome).toMatchObject({ ok: false, failure: { kind: 'network' } });
    const up = upstream(() => Promise.reject(new TypeError('offline')));
    expect(await streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: new AbortController().signal })).toEqual({ ok: false, failure: { kind: 'network' }, requestId: null });
  });
});

describe('size limits', () => {
  it('stops when the answer grows past maxTextChars', async () => {
    const { outcome, b } = run([delta('x'.repeat(60)), delta('y'.repeat(60)), completed()], { timing: { maxTextChars: 100 }, hang: true });
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'too-large' } });
    expect(b.cancelled()).toBe(true);
  });

  it('stops when one event or unfinished line grows past maxEventChars', async () => {
    const endless = run(['data: ' + 'z'.repeat(400), 'z'.repeat(400)], { timing: { maxEventChars: 600 }, hang: true });
    expect(await endless.outcome).toMatchObject({ ok: false, failure: { kind: 'too-large' } });
    expect(endless.b.cancelled()).toBe(true);
    const manyLines = run([Array.from({ length: 50 }, () => 'data: 0123456789\n').join('')], { timing: { maxEventChars: 300 }, hang: true });
    expect(await manyLines.outcome).toMatchObject({ ok: false, failure: { kind: 'too-large' } });
  });
});

describe('deadlines', () => {
  const timing = { headersMs: 1_000, idleMs: 2_000, totalMs: 10_000 };

  it('leaves no timer behind after a completed, a failed or a refused answer', async () => {
    vi.useFakeTimers();
    expect(await run([delta('a'), completed()], { timing }).outcome).toMatchObject({ ok: true });
    expect(await run([delta('a'), ev({ type: 'response.failed', response: { error: null } })], { timing }).outcome).toMatchObject({ ok: false });
    const up = upstream(() => new Response('{}', { status: 429 }));
    expect(await streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: new AbortController().signal, timing: { ...DEFAULT_STREAM_TIMING, ...timing } })).toMatchObject({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out when headers never arrive', async () => {
    vi.useFakeTimers();
    const up = upstream(() => new Promise<Response>(() => {}));
    const outcome = streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: new AbortController().signal, timing: { ...DEFAULT_STREAM_TIMING, ...timing } });
    await vi.advanceTimersByTimeAsync(999);
    expect(up.calls[0]!.init.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: false, failure: { kind: 'timeout' }, requestId: null });
    expect(up.calls[0]!.init.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out an error body that never finishes', async () => {
    vi.useFakeTimers();
    const b = body(['{"error":'], { hang: true });
    const up = upstream(() => new Response(b.stream, { status: 429 }));
    const outcome = streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: new AbortController().signal, timing: { ...DEFAULT_STREAM_TIMING, ...timing } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'timeout' } });
    expect(b.cancelled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a silent body, cancels it and clears every timer', async () => {
    vi.useFakeTimers();
    const { outcome, b } = run([delta('a')], { timing, hang: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'timeout' } });
    expect(b.cancelled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the total deadline on a body that trickles forever', async () => {
    vi.useFakeTimers();
    const { outcome, b } = run(Array.from({ length: 1_000 }, () => ': ping\n\n'), { timing, delayMs: 1_500 });
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'timeout' } });
    expect(b.cancelled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports the caller abort as aborted, not timeout, and does not call upstream once already aborted', async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const { outcome, b } = run([delta('a')], { timing, hang: true, signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort();
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'aborted' } });
    expect(b.cancelled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const early = run([completed()], { signal: AbortSignal.abort() });
    expect(await early.outcome).toMatchObject({ ok: false, failure: { kind: 'aborted' } });
    expect(early.up.calls).toHaveLength(0);
  });
});

describe('answers before the stream opens', () => {
  const status = (code: number, payload: unknown, headers: Record<string, string> = {}) => {
    const up = upstream(() => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status: code, headers }));
    return streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: new AbortController().signal });
  };

  it('maps statuses and documented codes, keeping no upstream text', async () => {
    const auth = await status(401, { detail: 'secret-bearing diagnostic' }, { 'x-request-id': 'req_401' });
    expect(auth).toEqual({ ok: false, failure: { kind: 'auth' }, requestId: 'req_401' });
    expect(JSON.stringify(auth)).not.toContain('diagnostic');
    expect(await status(401, { error: { code: 'subscription_sharing_invalid_user' } })).toMatchObject({ failure: { kind: 'auth' } });
    expect(await status(403, { error: { code: 'subscription_sharing_user_not_eligible' } })).toMatchObject({ failure: { kind: 'not-eligible' } });
    expect(await status(403, { error: { code: 'chatpass_v2_scope_not_authorized' } })).toMatchObject({ failure: { kind: 'forbidden', upstreamCode: 'chatpass_v2_scope_not_authorized' } });
    expect(await status(403, { detail: 'region' })).toMatchObject({ failure: { kind: 'forbidden', upstreamCode: null } });
    expect(await status(429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } })).toMatchObject({ failure: { kind: 'usage-limit' } });
    expect(await status(429, { error: { code: 'rate_limit_exceeded' } })).toMatchObject({ failure: { kind: 'rate-limited' } });
    expect(await status(503, 'unavailable')).toMatchObject({ failure: { kind: 'unavailable' } });
    expect(await status(503, { error: { code: 'subscription_sharing_user_unavailable' } })).toMatchObject({ failure: { kind: 'unavailable' } });
    expect(await status(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'temperature' } })).toMatchObject({ failure: { kind: 'unsupported', param: 'temperature' } });
    expect(await status(404, { error: { code: 'model_not_found' } })).toMatchObject({ failure: { kind: 'rejected', status: 404, upstreamCode: 'model_not_found' } });
  });

  it('refuses to follow a redirect', async () => {
    const b = body(['moved']);
    const up = upstream(() => new Response(b.stream, { status: 307, headers: { location: 'https://evil.example/v1/responses' } }));
    expect(await streamResponse(up.http, { token: TOKEN, model: MODEL, request: REQUEST, signal: new AbortController().signal })).toEqual({ ok: false, failure: { kind: 'redirect' }, requestId: null });
    expect(up.calls).toHaveLength(1);
    expect(b.cancelled()).toBe(true);
  });
});

describe('the model list', () => {
  const list = (answer: () => Response) => {
    const up = upstream(answer);
    return { up, result: listModels(up.http, { token: TOKEN, signal: new AbortController().signal }) };
  };
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

  it('keeps listed models in server order with their slug and display name', async () => {
    const { up, result } = list(() =>
      json({
        models: [
          { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list' },
          { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list', extra: true },
          { slug: ' padded', display_name: 'Bad', visibility: 'list' },
          { slug: 'gpt-5.5 (preview)/x', display_name: 'Odd but fine', visibility: 'list' },
          { slug: 'gpt-c', display_name: '', visibility: 'list' },
          { id: 'gpt-d', display_name: 'No slug', visibility: 'list' },
          { slug: 'gpt-b', display_name: 'GPT B again', visibility: 'list' },
        ],
      }),
    );
    expect(await result).toEqual({
      ok: true,
      models: [
        { slug: 'gpt-b', displayName: 'GPT B' },
        { slug: 'gpt-a', displayName: 'GPT A' },
        { slug: 'gpt-5.5 (preview)/x', displayName: 'Odd but fine' },
      ],
      requestId: null,
    });
    expect(up.calls[0]!.url).toBe(MODELS);
    expect(up.calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer at-1' } });
  });

  it('caps the list at 100 entries', async () => {
    const models = Array.from({ length: 150 }, (_, i) => ({ slug: `m-${i}`, display_name: `M ${i}`, visibility: 'list' }));
    const r = await list(() => json({ models })).result;
    expect(r.ok && r.models.length).toBe(100);
    expect(r.ok && r.models[99]!.slug).toBe('m-99');
  });

  it('reports auth failures and unreadable catalogs', async () => {
    expect(await list(() => json({ detail: 'no' }, 401)).result).toMatchObject({ ok: false, failure: { kind: 'auth' } });
    expect(await list(() => new Response('x'.repeat(1024 * 1024 + 1), { status: 401 })).result).toMatchObject({ ok: false, failure: { kind: 'auth' } });
    expect(await list(() => json({ data: [] })).result).toMatchObject({ ok: false, failure: { kind: 'invalid-response' } });
    expect(await list(() => new Response(null, { status: 302 })).result).toMatchObject({ ok: false, failure: { kind: 'redirect' } });
  });
});
