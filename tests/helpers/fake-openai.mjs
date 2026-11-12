/**
 * TEST ONLY. A small stand-in for OpenAI's sign-in and plan endpoints, used by tests/chatgpt.account.test.ts (as a fetch
 * function) and by scripts/e2e-worker-server.mjs (over HTTP, for the real Worker in workerd). It is never imported by the
 * Worker or the app. It speaks the documented shapes: discovery, JWKS, the token endpoint (authorization_code with PKCE,
 * refresh_token with rotation and reuse detection), revocation, the model list and a streamed Responses answer. ID tokens
 * are RS256 JWTs signed here with node:crypto, so the app's verifier is tested against an independent signer.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export const AUTH = 'https://auth.openai.com';
export const API = 'https://api.openai.com';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const HANG = Symbol('hang');
const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createFakeOpenAi(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  const behaviour = {
    account: { sub: 'user-fake-1', email: 'student@example.test' },
    grantPlan: true,
    expiresIn: 3600,
    /** Seconds since the epoch, or null. Sent as `earliest_refresh_at` on every grant. */
    earliestRefreshAt: null,
    /**
     * For the next refresh only (then back to 'ok'). 'transient' is a 503 before anything rotates; 'rate-limited' a 429 and
     * 'rejected' a non-terminal 400, both before rotation. The 'rotate-then-*' answers rotate upstream first, then hang until
     * the caller aborts, answer 504, or answer a 200 nobody can parse.
     */
    nextRefresh: 'ok',
    /** Lifetime of each ID token, from its `iat`. */
    idTokenTtlS: 600,
    /** 'ok' | 'invalid-grant' | 'invalid-client' | 'transient', for the next code exchange only. */
    nextExchange: 'ok',
    models: [
      { slug: 'gpt-fake-large', display_name: 'Fake Large', visibility: 'list' },
      { slug: 'gpt-fake-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-fake-small', display_name: 'Fake Small', visibility: 'list' },
    ],
    /** Scripted Responses answers, used in order; when empty, `script` decides, and without it the default answer below. */
    responses: [],
    /** (body) => FakeScript. Reads the request like a model would (tests/helpers/scripted-model.mjs). */
    script: null,
    answer: '튜링 기계의 테이프는 무한한 기억 장치입니다 [S1].\n\nBASIS: lecture\nFOLLOWUPS: 헤드는 무엇인가요? | 어떻게 움직이나요? | 왜 무한한가요?',
  };

  const codes = new Map();
  const refreshTokens = new Map();
  const accessTokens = new Map();
  const log = [];
  const holds = new Map();
  let reused = 0;
  let clients = 0;
  let tokens = 0;

  const newToken = (kind) => `fake-${kind}-${(tokens += 1)}-${b64u(randomBytes(12))}`;

  /** The next request of `kind` waits until `release()`. `reached` settles once it is waiting. */
  function hold(kind) {
    let release;
    let reached;
    const gate = new Promise((r) => (release = r));
    const arrived = new Promise((r) => (reached = r));
    const list = holds.get(kind) ?? [];
    list.push({ gate, reached });
    holds.set(kind, list);
    return { release: () => release(), reached: arrived };
  }
  async function pass(kind) {
    const h = holds.get(kind)?.shift();
    if (!h) return;
    h.reached();
    await h.gate;
  }

  function idToken(clientId, nonce, account) {
    const iat = Math.floor(now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64u(JSON.stringify({ iss: AUTH, aud: clientId, sub: account.sub, email: account.email, nonce, iat, exp: iat + behaviour.idTokenTtlS }));
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${b64u(sig)}`;
  }

  function grant(clientId, account, scope, nonce) {
    const access = newToken('at');
    const refresh = newToken('rt');
    accessTokens.set(access, { clientId, sub: account.sub, expiresAt: now() + behaviour.expiresIn * 1000 });
    refreshTokens.set(refresh, { clientId, account, scope, state: 'live' });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: behaviour.expiresIn,
      scope,
      ...(behaviour.earliestRefreshAt !== null ? { earliest_refresh_at: behaviour.earliestRefreshAt } : {}),
      ...(nonce !== undefined ? { id_token: idToken(clientId, nonce, account) } : {}),
    };
  }

  /**
   * What the browser meets at the authorize endpoint: consent is given at once, and the answer is the callback address.
   * A dynamic registration is issued a fresh `oaiapp_` client id, as OpenAI does.
   */
  function authorize(href) {
    const q = new URL(href).searchParams;
    const redirectUri = q.get('redirect_uri') ?? '';
    const back = new URL(redirectUri);
    const dynamic = q.get('client_id') === 'dynamic_agent_client';
    const clientId = dynamic ? `oaiapp_fake${(clients += 1)}` : q.get('client_id');
    log.push({ kind: 'authorize', clientId: q.get('client_id'), agentNameHint: q.get('agent_name_hint'), prompt: q.get('prompt'), hasIdTokenHint: q.has('id_token_hint') });
    const code = `code-${b64u(randomBytes(12))}`;
    const scopes = (q.get('scope') ?? '').split(' ').filter((s) => behaviour.grantPlan || s !== PLAN_SCOPE);
    codes.set(code, { clientId, redirectUri, challenge: q.get('code_challenge'), nonce: q.get('nonce'), scope: scopes.join(' '), account: { ...behaviour.account } });
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    if (dynamic) back.searchParams.set('client_id', clientId);
    return back.toString();
  }

  /** Upstream acts at once; only the answer is held. That is the case that matters: rotated upstream, not yet seen here. */
  async function token(form, signal) {
    const kind = form.get('grant_type') === 'authorization_code' ? 'exchange' : 'refresh';
    const answer = tokenAnswer(form);
    await pass(kind);
    if (answer !== HANG) return answer;
    return new Promise((_, reject) => {
      const cut = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) cut();
      else signal?.addEventListener('abort', cut, { once: true });
    });
  }

  function tokenAnswer(form) {
    if (form.get('grant_type') === 'authorization_code') {
      const c = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      log.push({ kind: 'exchange', clientId: form.get('client_id') });
      const scripted = behaviour.nextExchange;
      behaviour.nextExchange = 'ok';
      if (scripted === 'transient') return json(503, { error: 'temporarily_unavailable' });
      if (scripted === 'invalid-client') return json(401, { error: 'invalid_client' });
      if (!c || scripted === 'invalid-grant') return json(400, { error: 'invalid_grant' });
      const challenge = b64u(createHash('sha256').update(form.get('code_verifier') ?? '').digest());
      if (c.clientId !== form.get('client_id') || c.redirectUri !== form.get('redirect_uri') || c.challenge !== challenge) return json(400, { error: 'invalid_grant' });
      return json(200, grant(c.clientId, c.account, c.scope, c.nonce));
    }
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const entry = { kind: 'refresh', clientId: form.get('client_id'), token: presented };
      log.push(entry);
      const answer = behaviour.nextRefresh;
      behaviour.nextRefresh = 'ok';
      if (answer === 'transient') return json(503, { error: 'temporarily_unavailable' });
      if (answer === 'rate-limited') return json(429, { error: 'rate_limited' });
      if (answer === 'rejected') return json(400, { error: 'invalid_request' });
      if (answer === 'invalid-client') return json(401, { error: 'invalid_client' });
      const r = refreshTokens.get(presented);
      if (answer === 'terminal' || !r || r.clientId !== form.get('client_id')) return json(400, { error: 'invalid_grant' });
      if (r.state === 'used') {
        reused += 1;
        return json(400, { error: 'refresh_token_reused' });
      }
      if (r.state === 'revoked') return json(400, { error: 'invalid_grant' });
      r.state = 'used';
      const body = grant(r.clientId, r.account, r.scope);
      entry.rotatedTo = body.refresh_token;
      if (answer === 'rotate-then-hang') return HANG;
      if (answer === 'rotate-then-504') return json(504, { error: 'gateway_timeout' });
      if (answer === 'rotate-then-garbage') return new Response('{"access_token": tr', { status: 200, headers: { 'content-type': 'application/json' } });
      return json(200, body);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  function sse(events) {
    const enc = new TextEncoder();
    const chunks = events.map((e) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    return new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
  }

  function answerText(text) {
    const parts = text.match(/[\s\S]{1,12}/g) ?? [];
    return sse([{ type: 'response.created' }, ...parts.map((delta) => ({ type: 'response.output_text.delta', delta })), { type: 'response.completed', response: { status: 'completed' } }]);
  }

  async function responses(init) {
    const bearer = /^Bearer (.+)$/.exec(init.headers?.authorization ?? '')?.[1];
    const body = JSON.parse(init.body ?? '{}');
    log.push({ kind: 'responses', token: bearer ?? null, body });
    const script = behaviour.responses.shift() ?? behaviour.script?.(body) ?? { kind: 'text', text: behaviour.answer };
    await pass('responses');
    const a = bearer ? accessTokens.get(bearer) : undefined;
    if (!a || a.expiresAt <= now()) return json(401, { detail: 'Unauthorized' });
    if (script.kind === 'http') return json(script.status, script.body);
    if (script.kind === 'hang')
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    if (script.kind === 'failed') return new Response(sse([{ type: 'response.failed', response: { error: { code: script.code } } }]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(answerText(script.text ?? behaviour.answer), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fake_1' } });
  }

  /** An `OutboundFetch` for OpenAI's real addresses. Anything else is a test failure, loudly. */
  async function fetchLike(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.origin === AUTH && u.pathname === '/.well-known/openid-configuration')
      return json(200, { issuer: AUTH, jwks_uri: `${AUTH}/.well-known/jwks.json`, revocation_endpoint: `${AUTH}/api/accounts/oauth/revoke`, id_token_signing_alg_values_supported: ['RS256'] });
    if (u.origin === AUTH && u.pathname === '/.well-known/jwks.json') return json(200, { keys: [jwk] });
    if (u.origin === AUTH && u.pathname === '/api/accounts/oauth/token' && method === 'POST') return token(new URLSearchParams(init.body ?? ''), init.signal);
    if (u.origin === AUTH && u.pathname === '/api/accounts/oauth/revoke' && method === 'POST') {
      const form = new URLSearchParams(init.body ?? '');
      log.push({ kind: 'revoke', clientId: form.get('client_id'), token: form.get('token') });
      const r = refreshTokens.get(form.get('token') ?? '');
      if (r) r.state = 'revoked';
      await pass('revoke');
      return new Response(null, { status: 200 });
    }
    if (u.origin === API && u.pathname === '/v1/models' && method === 'GET') {
      log.push({ kind: 'models' });
      const bearer = /^Bearer (.+)$/.exec(init.headers?.authorization ?? '')?.[1];
      const a = bearer ? accessTokens.get(bearer) : undefined;
      if (!a || a.expiresAt <= now()) return json(401, { detail: 'Unauthorized' });
      return json(200, { models: behaviour.models });
    }
    if (u.origin === API && u.pathname === '/v1/responses' && method === 'POST') return responses(init);
    throw new Error(`fake OpenAI: unexpected ${method} ${u.origin}${u.pathname}`);
  }

  return {
    fetch: fetchLike,
    authorize,
    hold,
    behaviour,
    log,
    count: (kind) => log.filter((e) => e.kind === kind).length,
    refreshTokenState: (t) => refreshTokens.get(t)?.state ?? null,
    /** Every refresh token value presented for revocation, in order. */
    revoked: () => log.filter((e) => e.kind === 'revoke').map((e) => e.token),
    /** How many refreshes presented an already-rotated token. Zero means no send was ever repeated. */
    reused: () => reused,
    /** Every access token issued so far stops working, as after an upstream revocation. */
    invalidateAccess: () => {
      for (const a of accessTokens.values()) a.expiresAt = 0;
    },
    /** Every token value it ever issued, so a test can scan storage for any of them in clear text. */
    issued: () => [...accessTokens.keys(), ...refreshTokens.keys()],
  };
}

/**
 * The same fake over HTTP for the real Worker. Paths: /oai-auth/* is auth.openai.com, /oai-api/* is api.openai.com,
 * GET /oai-auth/api/accounts/authorize is the browser's consent page (its link goes back to the callback), /__oai/log is the log
 * without token values. Returns true when it answered.
 */
export async function serveFakeOpenAi(fake, req, res) {
  const url = req.url ?? '';
  if (url === '/__oai/log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fake.log.map(({ token: _t, rotatedTo: _r, body, ...rest }) => ({ ...rest, ...(body ? { body: { model: body.model, store: body.store, stream: body.stream, keys: Object.keys(body).sort() } } : {}) }))));
    return true;
  }
  const m = /^\/oai-(auth|api)(\/.*)$/.exec(url);
  if (!m) return false;
  const target = `${m[1] === 'auth' ? AUTH : API}${m[2]}`;
  if (req.method === 'GET' && m[1] === 'auth' && m[2].startsWith('/api/accounts/authorize?')) {
    // A consent page, as OpenAI shows one: the click here starts the trip back, so the callback is a cross-site navigation.
    const back = fake.authorize(target).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake OpenAI consent</title></head><body><h1>Fake OpenAI consent</h1><a href="${back}">Allow StudyAI</a></body></html>`);
    return true;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  const answer = await fake.fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined, signal: ctl.signal });
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (!answer.body) return res.end(), true;
  const reader = answer.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* the client went away */
  }
  res.end();
  return true;
}
