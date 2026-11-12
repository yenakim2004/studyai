import { createHmac, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeUrl,
  callbackClientId,
  completeSignIn,
  loopbackRedirectUri,
  newAttemptSecrets,
  newHostId,
  OpenAiDirectory,
  parseCallbackQuery,
  parseIssuedClientId,
  parseLoopbackRedirectUri,
  parseRefreshToken,
  pkceChallenge,
  refreshDecision,
  refreshGrant,
  revokeRefreshToken,
  type IssuedClientId,
  type OutboundFetch,
  type OutboundInit,
} from '../src/core/chatgpt/oauth';

afterEach(() => vi.useRealTimers());

const DISCOVERY = 'https://auth.openai.com/.well-known/openid-configuration';
const JWKS = 'https://auth.openai.com/.well-known/jwks.json';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const REVOKE = 'https://auth.openai.com/api/accounts/oauth/revoke';
const NOW = Date.UTC(2026, 10, 12, 6, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

const CLIENT = must(parseIssuedClientId('oaiapp_studyai1'));
const OTHER_CLIENT = must(parseIssuedClientId('oaiapp_someoneelse'));
const REDIRECT = must(loopbackRedirectUri(8790));
const RT = must(parseRefreshToken('rt-old'));
const signal = (): AbortSignal => new AbortController().signal;

function must<T>(v: T | null): T {
  if (v === null) throw new Error('fixture did not parse');
  return v;
}

const rsa = (): { privateKey: KeyObject; jwk: Record<string, unknown> } => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown> };
};
const KEY_A = rsa();
const KEY_B = rsa();
const jwkOf = (k: typeof KEY_A, kid: string) => ({ ...k.jwk, kid, use: 'sig', alg: 'RS256' });

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
function rs256(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', ...header })}.${b64(payload)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://auth.openai.com',
  aud: CLIENT,
  sub: 'user-123',
  email: 'student@example.com',
  nonce: 'nonce-1',
  iat: NOW_S - 10,
  exp: NOW_S + 3600,
  ...over,
});
const idToken = (over: Record<string, unknown> = {}, header: Record<string, unknown> = { kid: 'a' }, key = KEY_A.privateKey) => rs256(header, claims(over), key);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Route = (init: OutboundInit) => Response | Promise<Response>;
function upstream(routes: Record<string, Route | Route[]>) {
  const calls: { url: string; init: OutboundInit }[] = [];
  const http: OutboundFetch = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    const route = Array.isArray(r) ? r[Math.min(calls.filter((c) => c.url === url).length, r.length) - 1] : r;
    if (!route) throw new TypeError(`unexpected fetch ${url}`);
    return route(init);
  };
  return { http, calls, count: (url: string) => calls.filter((c) => c.url === url).length };
}

const discovery = (over: Record<string, unknown> = {}) => ({
  issuer: 'https://auth.openai.com',
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: TOKEN,
  revocation_endpoint: REVOKE,
  jwks_uri: JWKS,
  id_token_signing_alg_values_supported: ['RS256'],
  ...over,
});
const directoryRoutes = (keys: unknown[] = [jwkOf(KEY_A, 'a')]): Record<string, Route> => ({
  [DISCOVERY]: () => json(discovery()),
  [JWKS]: () => json({ keys }),
});

const tokenBody = (over: Record<string, unknown> = {}) => ({
  access_token: 'at-new',
  refresh_token: 'rt-new',
  id_token: idToken(),
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  ...over,
});
const form = (init: OutboundInit) => Object.fromEntries(new URLSearchParams(init.body ?? ''));

describe('the authorize URL', () => {
  const secrets = { state: 'state-1', nonce: 'nonce-1', verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' };
  const hostId = newHostId();

  it('registers a new client as StudyAI through dynamic_agent_client, with PKCE, state, nonce and the loopback callback', async () => {
    const url = new URL(await authorizeUrl({ client: { kind: 'dynamic' }, hostId, redirectUri: REDIRECT, secrets, forceConsent: false }));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'StudyAI',
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:8790/auth/callback',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge_method: 'S256',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    });
  });

  it('reauthorizes with the issued id: no agent name, an optional login hint, prompt=consent only when asked, never an ID token', async () => {
    const client = { kind: 'issued' as const, clientId: CLIENT, loginHint: 'student@example.com' };
    const plain = new URL(await authorizeUrl({ client, hostId, redirectUri: REDIRECT, secrets, forceConsent: false })).searchParams;
    expect(plain.get('client_id')).toBe(CLIENT);
    expect(plain.get('login_hint')).toBe('student@example.com');
    expect(plain.has('agent_name_hint')).toBe(false);
    expect(plain.has('prompt')).toBe(false);
    expect(plain.has('id_token_hint')).toBe(false);
    const consent = new URL(await authorizeUrl({ client: { ...client, loginHint: null }, hostId, redirectUri: REDIRECT, secrets, forceConsent: true })).searchParams;
    expect(consent.get('prompt')).toBe('consent');
    expect(consent.has('login_hint')).toBe(false);
  });

  it('computes the S256 challenge from the RFC 7636 appendix B example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('mints fresh 256-bit url-safe secrets and a v4 host id', () => {
    const a = newAttemptSecrets();
    const b = newAttemptSecrets();
    for (const v of [a.state, a.nonce, a.verifier]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.state, a.nonce, a.verifier, b.state, b.nonce, b.verifier]).size).toBe(6);
    expect(newHostId()).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it('accepts only http://127.0.0.1:<port>/auth/callback as the redirect', () => {
    expect(parseLoopbackRedirectUri('http://127.0.0.1:1455/auth/callback')).toBe('http://127.0.0.1:1455/auth/callback');
    for (const bad of [
      'http://localhost:1455/auth/callback',
      'https://127.0.0.1:1455/auth/callback',
      'http://127.0.0.1/auth/callback',
      'http://127.0.0.1:1455/callback',
      'http://127.0.0.1:1455/auth/callback?x=1',
      'http://127.0.0.1:70000/auth/callback',
      'http://127.0.0.2:1455/auth/callback',
    ])
      expect(parseLoopbackRedirectUri(bad), bad).toBeNull();
    expect(loopbackRedirectUri(0)).toBeNull();
  });
});

describe('the callback', () => {
  it('reads a code, the returned client id and state', () => {
    expect(parseCallbackQuery(new URLSearchParams('code=c1&state=s1&client_id=oaiapp_x&scope=openid'))).toEqual({ kind: 'code', state: 's1', code: 'c1', clientId: 'oaiapp_x' });
    expect(parseCallbackQuery(new URLSearchParams('code=c1&state=s1'))).toEqual({ kind: 'code', state: 's1', code: 'c1', clientId: null });
  });

  it('reports a declined consent as an error slug, and drops free text', () => {
    expect(parseCallbackQuery(new URLSearchParams('error=access_denied&state=s1'))).toEqual({ kind: 'error', state: 's1', error: 'access_denied' });
    expect(parseCallbackQuery(new URLSearchParams('error=<script>&state=s1'))).toEqual({ kind: 'error', state: 's1', error: 'unknown' });
  });

  it('refuses a query without state, with repeated parameters, or without code', () => {
    for (const q of ['code=c1', 'code=c1&state=s1&state=s2', 'code=c1&code=c2&state=s1', 'state=s1', `code=c1&state=${'x'.repeat(600)}`]) expect(parseCallbackQuery(new URLSearchParams(q)), q).toBeNull();
  });

  it('takes the issued id on a new registration and the saved id on reauth, rejecting a different one', () => {
    expect(callbackClientId({ kind: 'dynamic' }, 'oaiapp_new1')).toBe('oaiapp_new1');
    expect(callbackClientId({ kind: 'dynamic' }, null)).toBeNull();
    expect(callbackClientId({ kind: 'dynamic' }, 'dynamic_agent_client')).toBeNull();
    const issued = { kind: 'issued' as const, clientId: CLIENT, loginHint: null };
    expect(callbackClientId(issued, null)).toBe(CLIENT);
    expect(callbackClientId(issued, CLIENT)).toBe(CLIENT);
    expect(callbackClientId(issued, OTHER_CLIENT)).toBeNull();
  });
});

describe('completing a sign-in', () => {
  const attempt = { clientId: CLIENT, code: 'code-1', verifier: 'verifier-1', redirectUri: REDIRECT, nonce: 'nonce-1', now: NOW };
  const run = (token: Route, keys?: unknown[]) => {
    const up = upstream({ ...directoryRoutes(keys), [TOKEN]: token });
    const dir = new OpenAiDirectory({ http: up.http, now: () => NOW });
    return { up, result: completeSignIn(up.http, dir, { ...attempt, signal: signal() }) };
  };

  it('exchanges the code at the fixed endpoint and returns the verified account with its tokens', async () => {
    const { up, result } = run(() => json(tokenBody({ earliest_refresh_at: NOW_S + 600 })));
    expect(await result).toEqual({
      ok: true,
      clientId: CLIENT,
      identity: { subject: 'user-123', email: 'student@example.com' },
      grant: {
        accessToken: 'at-new',
        refreshToken: 'rt-new',
        expiresAt: NOW + 3_600_000,
        earliestRefreshAt: NOW + 600_000,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      },
    });
    const exchange = up.calls.find((c) => c.url === TOKEN)!;
    expect(exchange.init.method).toBe('POST');
    expect(exchange.init.redirect).toBe('manual');
    expect(form(exchange.init)).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT,
      code: 'code-1',
      code_verifier: 'verifier-1',
      redirect_uri: 'http://127.0.0.1:8790/auth/callback',
      resource: 'https://api.openai.com/v1',
    });
  });

  it('turns invalid_grant into code-rejected, keeps upstream text out, and has nothing to revoke', async () => {
    const r = await run(() => json({ error: 'invalid_grant', error_description: 'leaky upstream sentence' }, 400)).result;
    expect(r).toEqual({ ok: false, failure: { kind: 'token', failure: { kind: 'code-rejected' } }, orphan: null });
    expect(JSON.stringify(r)).not.toContain('leaky');
  });

  it('classifies other exchange answers', async () => {
    expect(await run(() => json({ error: 'invalid_client' }, 401)).result).toMatchObject({ ok: false, failure: { failure: { kind: 'invalid-client' } } });
    expect(await run(() => json({ error: 'invalid_request' }, 400)).result).toMatchObject({ failure: { failure: { kind: 'rejected', status: 400, code: 'invalid_request' } } });
    expect(await run(() => json({ error: 'invalid_refresh_token' }, 400)).result).toMatchObject({ failure: { failure: { kind: 'rejected' } } });
    expect(await run(() => new Response('oops', { status: 503 })).result).toMatchObject({ failure: { failure: { kind: 'transient' } } });
    expect(await run(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })).result).toMatchObject({ failure: { failure: { kind: 'transient' } } });
    expect(await run(() => Promise.reject(new TypeError('offline'))).result).toMatchObject({ failure: { failure: { kind: 'transient' } } });
    expect(await run(() => new Response('x'.repeat(70_000), { status: 503 })).result).toMatchObject({ failure: { failure: { kind: 'transient' } } });
  });

  it('rejects a 200 it cannot trust, and hands back any refresh token it was given for revocation', async () => {
    const noScope = await run(() => json(tokenBody({ scope: undefined }))).result;
    expect(noScope).toEqual({ ok: false, failure: { kind: 'token', failure: { kind: 'invalid-response' } }, orphan: 'rt-new' });
    expect(await run(() => json(tokenBody({ refresh_token: undefined }))).result).toEqual({ ok: false, failure: { kind: 'token', failure: { kind: 'invalid-response' } }, orphan: null });
    for (const over of [{ token_type: 'mac' }, { expires_in: -5 }, { access_token: '' }])
      expect(await run(() => json(tokenBody(over))).result, JSON.stringify(over)).toEqual({ ok: false, failure: { kind: 'token', failure: { kind: 'invalid-response' } }, orphan: 'rt-new' });
    expect(await run(() => json(tokenBody({ id_token: undefined }))).result).toEqual({ ok: false, failure: { kind: 'no-id-token' }, orphan: 'rt-new' });
  });

  it('refuses a body larger than the cap', async () => {
    expect(await run(() => json(tokenBody({ padding: 'x'.repeat(70_000) }))).result).toMatchObject({ ok: false, failure: { failure: { kind: 'invalid-response' } } });
  });

  it('keeps verified identity when plan consent is absent without granting inference', async () => {
    const r = await run(() => json(tokenBody({ scope: 'openid profile email offline_access' }))).result;
    expect(r).toEqual({ ok: false, failure: { kind: 'plan-not-granted', identity: { subject: 'user-123', email: 'student@example.com' } }, orphan: 'rt-new' });
    expect(await run(() => json(tokenBody({ scope: 'openid', id_token: idToken({ nonce: 'wrong' }) }))).result).toEqual({ ok: false, failure: { kind: 'identity', problem: 'nonce-mismatch' }, orphan: 'rt-new' });
  });

  it('rejects an ID token for another attempt or client', async () => {
    expect(await run(() => json(tokenBody({ id_token: idToken({ nonce: 'other' }) }))).result).toEqual({ ok: false, failure: { kind: 'identity', problem: 'nonce-mismatch' }, orphan: 'rt-new' });
    expect(await run(() => json(tokenBody({ id_token: idToken({ aud: OTHER_CLIENT }) }))).result).toMatchObject({ ok: false, failure: { kind: 'identity', problem: 'wrong-audience' } });
  });
});

describe('ID-token verification', () => {
  const expect_ = { clientId: CLIENT, nonce: 'nonce-1' };
  const verify = async (token: string, o: { now?: number; keys?: unknown[] | unknown[][]; disc?: Record<string, unknown>; client?: IssuedClientId } = {}) => {
    const keyRoutes = Array.isArray(o.keys?.[0]) ? (o.keys as unknown[][]).map((k) => () => json({ keys: k })) : () => json({ keys: (o.keys as unknown[] | undefined) ?? [jwkOf(KEY_A, 'a')] });
    const up = upstream({ [DISCOVERY]: () => json(discovery(o.disc)), [JWKS]: keyRoutes, 'https://evil.example/jwks': () => json({ keys: [jwkOf(KEY_B, 'b')] }) });
    const dir = new OpenAiDirectory({ http: up.http, now: () => o.now ?? NOW });
    return { up, dir, result: await dir.verifyIdToken(token, { ...expect_, clientId: o.client ?? CLIENT }, signal()) };
  };

  it('accepts a token signed by a published key with the right claims', async () => {
    expect((await verify(idToken())).result).toEqual({ ok: true, identity: { subject: 'user-123', email: 'student@example.com' } });
    expect((await verify(idToken({ email: undefined }))).result).toEqual({ ok: true, identity: { subject: 'user-123', email: null } });
    expect((await verify(idToken({ email: 7 }))).result).toEqual({ ok: true, identity: { subject: 'user-123', email: null } });
    expect((await verify(idToken({ azp: 7 }))).result).toEqual({ ok: false, problem: 'wrong-audience' });
  });

  it('rejects wrong issuer, audience, expiry, nonce and subject', async () => {
    expect((await verify(idToken({ iss: 'https://evil.example' }))).result).toEqual({ ok: false, problem: 'wrong-issuer' });
    expect((await verify(idToken({ aud: OTHER_CLIENT }))).result).toEqual({ ok: false, problem: 'wrong-audience' });
    expect((await verify(idToken(), { now: NOW + 3600_000 + 61_000 })).result).toEqual({ ok: false, problem: 'expired' });
    expect((await verify(idToken(), { now: NOW + 3600_000 + 30_000 })).result.ok).toBe(true);
    expect((await verify(idToken({ nonce: 'replayed' }))).result).toEqual({ ok: false, problem: 'nonce-mismatch' });
    expect((await verify(idToken({ sub: '' }))).result.ok).toBe(false);
    expect((await verify(idToken({ nonce: undefined }))).result.ok).toBe(false);
  });

  it('accepts several audiences only when azp names this client', async () => {
    expect((await verify(idToken({ aud: [CLIENT, 'other'], azp: CLIENT }))).result.ok).toBe(true);
    expect((await verify(idToken({ aud: [CLIENT, 'other'] }))).result).toEqual({ ok: false, problem: 'wrong-audience' });
    expect((await verify(idToken({ azp: OTHER_CLIENT }))).result).toEqual({ ok: false, problem: 'wrong-audience' });
  });

  it('rejects unsigned, HMAC-with-the-public-key and tampered tokens', async () => {
    const none = `${b64({ alg: 'none', kid: 'a' })}.${b64(claims())}.`;
    expect((await verify(none)).result.ok).toBe(false);
    const hsInput = `${b64({ alg: 'HS256', kid: 'a' })}.${b64(claims())}`;
    const pem = createPublicKey(KEY_A.privateKey).export({ format: 'pem', type: 'spki' });
    const hs = `${hsInput}.${createHmac('sha256', pem).update(hsInput).digest('base64url')}`;
    expect((await verify(hs)).result).toEqual({ ok: false, problem: 'bad-signature' });
    const [h, , s] = idToken().split('.');
    expect((await verify(`${h}.${b64(claims({ sub: 'attacker' }))}.${s}`)).result).toEqual({ ok: false, problem: 'bad-signature' });
    expect((await verify(idToken({}, { kid: 'a' }, KEY_B.privateKey))).result).toEqual({ ok: false, problem: 'bad-signature' });
  });

  it('never fetches keys from a token header', async () => {
    const { up, result } = await verify(idToken({}, { kid: 'b', jku: 'https://evil.example/jwks', x5u: 'https://evil.example/cert' }, KEY_B.privateKey));
    expect(result.ok).toBe(false);
    expect(new Set(up.calls.map((c) => c.url))).toEqual(new Set([DISCOVERY, JWKS]));
  });

  it('refetches the JWKS once for an unknown kid, so a rotated key verifies', async () => {
    const rotated = await verify(idToken({}, { kid: 'b' }, KEY_B.privateKey), { keys: [[jwkOf(KEY_A, 'a')], [jwkOf(KEY_A, 'a'), jwkOf(KEY_B, 'b')]] });
    expect(rotated.result.ok).toBe(true);
    expect(rotated.up.count(JWKS)).toBe(2);
    const unknown = await verify(idToken({}, { kid: 'zz' }));
    expect(unknown.result).toEqual({ ok: false, problem: 'bad-signature' });
    expect(unknown.up.count(JWKS)).toBe(2);
  });

  it('caches discovery and keys between verifications', async () => {
    const { up, dir } = await verify(idToken());
    expect((await dir.verifyIdToken(idToken(), expect_, signal())).ok).toBe(true);
    expect(up.count(DISCOVERY)).toBe(1);
    expect(up.count(JWKS)).toBe(1);
  });

  it('refuses a directory that leaves the issuer or publishes no allowed algorithm', async () => {
    const offOrigin = await verify(idToken(), { disc: { jwks_uri: 'https://evil.example/jwks' } });
    expect(offOrigin.result).toEqual({ ok: false, problem: 'directory-invalid' });
    expect(offOrigin.up.count('https://evil.example/jwks')).toBe(0);
    expect((await verify(idToken(), { disc: { issuer: 'https://evil.example' } })).result).toEqual({ ok: false, problem: 'directory-invalid' });
    expect((await verify(idToken(), { disc: { id_token_signing_alg_values_supported: ['HS256', 'none'] } })).result).toEqual({ ok: false, problem: 'directory-invalid' });
  });

  it('pins algorithms to what discovery publishes', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecJwk = { ...(ec.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'e', use: 'sig', alg: 'ES256' };
    const input = `${b64({ alg: 'ES256', kid: 'e' })}.${b64(claims())}`;
    const es = `${input}.${sign('sha256', Buffer.from(input), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    expect((await verify(es, { keys: [ecJwk] })).result).toEqual({ ok: false, problem: 'bad-signature' });
    expect((await verify(es, { keys: [ecJwk], disc: { id_token_signing_alg_values_supported: ['RS256', 'ES256'] } })).result.ok).toBe(true);
  });

  it('reports unavailable keys when discovery cannot be fetched', async () => {
    const up = upstream({ [DISCOVERY]: () => new Response('down', { status: 503 }) });
    const dir = new OpenAiDirectory({ http: up.http, now: () => NOW });
    expect(await dir.verifyIdToken(idToken(), expect_, signal())).toEqual({ ok: false, problem: 'keys-unavailable' });
  });
});

describe('refreshing', () => {
  const refresh = (route: Route) => {
    const up = upstream({ [TOKEN]: route });
    return { up, result: refreshGrant(up.http, { clientId: CLIENT, refreshToken: RT, now: NOW, signal: signal() }) };
  };

  it('sends the issued client id and the refresh token without scope, and stores the rotated pair', async () => {
    const { up, result } = refresh(() => json(tokenBody({ id_token: undefined })));
    expect(await result).toEqual({
      ok: true,
      grant: { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: NOW + 3_600_000, earliestRefreshAt: null, scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] },
    });
    expect(form(up.calls[0]!.init)).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: 'rt-old', resource: 'https://api.openai.com/v1' });
  });

  it('marks an omitted scope with null so the previous grant is kept explicitly', async () => {
    expect(await refresh(() => json(tokenBody({ scope: undefined }))).result).toMatchObject({ ok: true, grant: { scopes: null } });
  });

  it('keeps a good rotation even when fields it does not use are null or odd', async () => {
    for (const over of [{ id_token: null }, { scope: null }, { earliest_refresh_at: { at: 1 } }, { earliest_refresh_at: null }, { id_token: 42, scope: 7 }])
      expect(await refresh(() => json(tokenBody(over))).result, JSON.stringify(over)).toMatchObject({ ok: true, grant: { accessToken: 'at-new', refreshToken: 'rt-new', earliestRefreshAt: null } });
  });

  it('reports the replacement token of an answer it refuses, so the caller can revoke it', async () => {
    expect(await refresh(() => json(tokenBody({ token_type: 'mac' }))).result).toEqual({ ok: false, failure: { kind: 'invalid-response' }, orphan: 'rt-new' });
  });

  it('never reuses the old refresh token when the answer has no replacement', async () => {
    expect(await refresh(() => json(tokenBody({ refresh_token: undefined }))).result).toEqual({ ok: false, failure: { kind: 'invalid-response' } , orphan: null });
  });

  it('treats the documented unusable-token codes as terminal, and nothing else', async () => {
    for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
      expect(await refresh(() => json({ error: code }, 400)).result, code).toEqual({ ok: false, failure: { kind: 'terminal' } , orphan: null });
    expect(await refresh(() => json({ error: 'invalid_client' }, 401)).result).toEqual({ ok: false, failure: { kind: 'invalid-client' } , orphan: null });
    expect(await refresh(() => json({ error: 'invalid_request' }, 400)).result).toEqual({ ok: false, failure: { kind: 'rejected', status: 400, code: 'invalid_request' } , orphan: null });
    expect(await refresh(() => json({ detail: 'no code here' }, 400)).result).toEqual({ ok: false, failure: { kind: 'rejected', status: 400, code: null } , orphan: null });
    expect(await refresh(() => json({ error: 'slow_down' }, 429)).result).toEqual({ ok: false, failure: { kind: 'transient' } , orphan: null });
    expect(await refresh(() => new Response('bad gateway', { status: 502 })).result).toEqual({ ok: false, failure: { kind: 'transient' } , orphan: null });
  });

  it('times out a hung token endpoint and a hung body, leaving no timer behind', async () => {
    vi.useFakeTimers();
    expect(await refresh(() => json(tokenBody())).result).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    const hung = refresh(() => new Promise<Response>(() => {})).result;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await hung).toEqual({ ok: false, failure: { kind: 'transient' }, orphan: null });
    expect(vi.getTimerCount()).toBe(0);

    let cancelled = false;
    const slowBody = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => void (cancelled = true) });
    const stalled = refresh(() => new Response(slowBody, { status: 200 })).result;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await stalled).toEqual({ ok: false, failure: { kind: 'transient' }, orphan: null });
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at once when the caller aborts', async () => {
    const up = upstream({ [TOKEN]: () => new Promise<Response>(() => {}) });
    const ctl = new AbortController();
    const pending = refreshGrant(up.http, { clientId: CLIENT, refreshToken: RT, now: NOW, signal: ctl.signal });
    ctl.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'transient' }, orphan: null });
  });
});

describe('when to refresh', () => {
  it('keeps outage status when the refresh endpoint returns a large error page', async () => {
    for (const status of [429, 503]) {
      const up = upstream({ [TOKEN]: () => new Response('x'.repeat(70_000), { status }) });
      expect(await refreshGrant(up.http, { clientId: CLIENT, refreshToken: RT, now: NOW, signal: signal() })).toEqual({ ok: false, failure: { kind: 'transient' }, orphan: null });
    }
  });

  const earliest = async (value: unknown) => {
    const up = upstream({ [TOKEN]: () => json(tokenBody({ earliest_refresh_at: value })) });
    const r = await refreshGrant(up.http, { clientId: CLIENT, refreshToken: RT, now: NOW, signal: signal() });
    if (!r.ok) throw new Error('refresh failed');
    return r.grant.earliestRefreshAt;
  };

  it('reads earliest_refresh_at as Unix seconds or an ISO date, and drops values it cannot place', async () => {
    expect(await earliest(1_790_032_532)).toBe(1_790_032_532_000);
    expect(await earliest('2026-11-12T06:10:00Z')).toBe(Date.UTC(2026, 10, 12, 6, 10, 0));
    expect(await earliest('2026-11-12T15:10:00+09:00')).toBe(Date.UTC(2026, 10, 12, 6, 10, 0));
    expect(await earliest(1_790_032_532_000)).toBeNull();
    for (const bad of ['soon', '1790032532', '', -1, null, true]) expect(await earliest(bad), String(bad)).toBeNull();
  });

  it('respects the early refresh time only while the access token remains valid', () => {
    expect(refreshDecision({ expiresAt: NOW + 120_000, earliestRefreshAt: null }, NOW)).toEqual({ kind: 'use' });
    expect(refreshDecision({ expiresAt: NOW + 30_000, earliestRefreshAt: null }, NOW)).toEqual({ kind: 'refresh' });
    expect(refreshDecision({ expiresAt: NOW + 30_000, earliestRefreshAt: NOW + 10_000 }, NOW)).toEqual({ kind: 'use' });
    expect(refreshDecision({ expiresAt: NOW - 1, earliestRefreshAt: NOW + 10_000 }, NOW)).toEqual({ kind: 'refresh' });
    expect(refreshDecision({ expiresAt: NOW, earliestRefreshAt: NOW + 1e12 }, NOW)).toEqual({ kind: 'refresh' });
    expect(refreshDecision({ expiresAt: NOW - 1, earliestRefreshAt: NOW - 5 }, NOW)).toEqual({ kind: 'refresh' });
  });
});

describe('revocation', () => {
  const revoke = (route: Route, disc: Route = () => json(discovery())) => {
    const up = upstream({ [DISCOVERY]: disc, [REVOKE]: route });
    const dir = new OpenAiDirectory({ http: up.http, now: () => NOW });
    return { up, result: revokeRefreshToken(up.http, dir, { clientId: CLIENT, refreshToken: RT, signal: signal() }) };
  };

  it('posts the refresh token to the discovered endpoint and counts an empty 200 as revoked', async () => {
    const { up, result } = revoke(() => new Response(null, { status: 200 }));
    expect(await result).toBe('revoked');
    const call = up.calls.find((c) => c.url === REVOKE)!;
    expect(call.init.redirect).toBe('manual');
    expect(form(call.init)).toEqual({ token: 'rt-old', token_type_hint: 'refresh_token', client_id: CLIENT });
  });

  it('says whether a retry can help', async () => {
    expect(await revoke(() => new Response('', { status: 503 })).result).toBe('transient');
    expect(await revoke(() => Promise.reject(new TypeError('offline'))).result).toBe('transient');
    expect(await revoke(() => json({ error: 'invalid_request' }, 400)).result).toBe('rejected');
    expect(await revoke(() => new Response(null, { status: 200 }), () => new Response('', { status: 500 })).result).toBe('transient');
  });

  it('never sends the token to an endpoint off the issuer origin', async () => {
    const { up, result } = revoke(() => new Response(null, { status: 200 }), () => json(discovery({ revocation_endpoint: 'https://evil.example/revoke' })));
    expect(await result).toBe('rejected');
    expect(up.calls.map((c) => c.url)).toEqual([DISCOVERY]);
  });
});
