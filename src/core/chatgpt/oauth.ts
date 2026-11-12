import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWSAlgorithm } from 'jose';
import { z } from 'zod';

export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const RESOURCE = 'https://api.openai.com/v1';
export const CALLBACK_PATH = '/auth/callback';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
export const AGENT_NAME = 'StudyAI';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const REQUESTED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE] as const;

const OAUTH_TIMEOUT_MS = 15_000;
const TOKEN_BODY_BYTES = 64 * 1024;
const DIRECTORY_BODY_BYTES = 128 * 1024;
const REVOKE_BODY_BYTES = 16 * 1024;
const DIRECTORY_TTL_MS = 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 60_000;
const CLOCK_TOLERANCE_S = 60;
const ALLOWED_ID_TOKEN_ALGS: readonly JWSAlgorithm[] = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const TERMINAL_REFRESH_CODES = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

const MAX_TOKEN_CHARS = 16 * 1024;
const IssuedClientIdSchema = z.string().regex(/^oaiapp_[A-Za-z0-9_-]{1,200}$/).brand<'IssuedClientId'>();
const HostIdSchema = z
  .string()
  .regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .brand<'HostId'>();
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/auth\/callback$/;
const RedirectUriSchema = z
  .string()
  .refine((uri) => {
    const port = LOOPBACK_RE.exec(uri)?.[1];
    return port !== undefined && Number(port) <= 65_535;
  })
  .brand<'LoopbackRedirectUri'>();
const AccessTokenSchema = z.string().min(1).max(MAX_TOKEN_CHARS).brand<'AccessToken'>();
const RefreshTokenSchema = z.string().min(1).max(MAX_TOKEN_CHARS).brand<'RefreshToken'>();
const SubjectSchema = z.string().min(1).max(255).brand<'Subject'>();

/** `oaiapp_…`, as issued on the new-registration callback. Never `dynamic_agent_client`. */
export type IssuedClientId = z.infer<typeof IssuedClientIdSchema>;
/** `urn:uuid:<v4>`, minted once per host and kept before the first sign-in. An identifier, not a credential. */
export type HostId = z.infer<typeof HostIdSchema>;
/** Exactly `http://127.0.0.1:<port>/auth/callback`; the docs allow only the port to vary and forbid `localhost`. */
export type LoopbackRedirectUri = z.infer<typeof RedirectUriSchema>;
export type AccessToken = z.infer<typeof AccessTokenSchema>;
export type RefreshToken = z.infer<typeof RefreshTokenSchema>;
/** The `sub` of a verified ID token: the ChatGPT account identity. */
export type Subject = z.infer<typeof SubjectSchema>;

const parsed = <S extends z.ZodType>(schema: S, raw: unknown): z.output<S> | null => {
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
};
export const parseIssuedClientId = (raw: unknown): IssuedClientId | null => parsed(IssuedClientIdSchema, raw);
export const parseHostId = (raw: unknown): HostId | null => parsed(HostIdSchema, raw);
export const parseLoopbackRedirectUri = (raw: unknown): LoopbackRedirectUri | null => parsed(RedirectUriSchema, raw);
export const parseAccessToken = (raw: unknown): AccessToken | null => parsed(AccessTokenSchema, raw);
export const parseRefreshToken = (raw: unknown): RefreshToken | null => parsed(RefreshTokenSchema, raw);
export const parseSubject = (raw: unknown): Subject | null => parsed(SubjectSchema, raw);

export function loopbackRedirectUri(port: number): LoopbackRedirectUri | null {
  return parseLoopbackRedirectUri(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
}

export function newHostId(): HostId {
  const id = parseHostId(`urn:uuid:${crypto.randomUUID()}`);
  if (!id) throw new Error('crypto.randomUUID returned a value that is not a v4 UUID');
  return id;
}

/** The only fetch this protocol uses. `redirect: 'manual'` is fixed: Workers implement only follow|manual, and we follow none. */
export type OutboundFetch = (url: string, init: OutboundInit) => Promise<Response>;
export interface OutboundInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect: 'manual';
}

const CUT = Symbol('cut');
const noop = (): void => {};

/**
 * One request's deadlines. Named timers (total, headers, idle) and the caller's signal all abort one controller. `race`
 * makes any promise lose to that abort, so a fetch or a body read that ignores its signal still cannot outlive a deadline.
 * `release` must run on every exit; it clears every timer and detaches from the caller's signal.
 */
export class Deadlines {
  readonly #controller = new AbortController();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #parent: AbortSignal;
  #reason: 'timeout' | 'aborted' | null = null;
  readonly #onParentAbort = (): void => this.#cut('aborted');

  constructor(parent: AbortSignal) {
    this.#parent = parent;
    if (parent.aborted) this.#cut('aborted');
    else parent.addEventListener('abort', this.#onParentAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get reason(): 'timeout' | 'aborted' | null {
    return this.#reason;
  }

  arm(name: string, ms: number): void {
    this.disarm(name);
    if (this.#reason) return;
    this.#timers.set(
      name,
      setTimeout(() => this.#cut('timeout'), ms),
    );
  }

  disarm(name: string): void {
    const t = this.#timers.get(name);
    if (t !== undefined) clearTimeout(t);
    this.#timers.delete(name);
  }

  race<T>(p: Promise<T>): Promise<T> {
    const signal = this.#controller.signal;
    if (signal.aborted) {
      p.catch(noop);
      return Promise.reject(CUT);
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(CUT);
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  release(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#parent.removeEventListener('abort', this.#onParentAbort);
  }

  #cut(reason: 'timeout' | 'aborted'): void {
    if (this.#reason) return;
    this.#reason = reason;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#controller.abort();
  }
}

/** A 3xx, or the status-0 opaque redirect a browser gives for `redirect: 'manual'`. Never followed. */
export const isRedirect = (res: Response): boolean => res.status === 0 || (res.status >= 300 && res.status < 400);

/** `x-request-id`, kept only when it looks like an id, so it is safe to show and log. */
export function requestIdOf(res: Response): string | null {
  const id = res.headers.get('x-request-id');
  return id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : null;
}

/** An upstream error code reduced to a slug; anything else (free text, odd characters) is dropped. */
export function upstreamCode(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-z0-9_.]{1,80}$/.test(raw) ? raw : null;
}

/** Reads the body as text, at most `maxBytes`. Null when larger. Rejects when the deadline cuts the read. */
export async function readCapped(res: Response, maxBytes: number, deadlines: Deadlines): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await deadlines.race(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(noop);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export type HttpResult =
  | { kind: 'response'; status: number; text: string; requestId: string | null }
  | { kind: 'redirect' }
  | { kind: 'too-large' }
  | { kind: 'cut'; reason: 'timeout' | 'aborted' }
  | { kind: 'network' };

/** One bounded request: the timeout covers the fetch and the whole body read, and the body is capped. */
export async function sendBounded(
  http: OutboundFetch,
  req: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  limits: { signal: AbortSignal; timeoutMs: number; maxBytes: number },
): Promise<HttpResult> {
  const deadlines = new Deadlines(limits.signal);
  deadlines.arm('total', limits.timeoutMs);
  try {
    if (deadlines.reason) return { kind: 'cut', reason: deadlines.reason };
    const { url, ...init } = req;
    const res = await deadlines.race(http(url, { ...init, signal: deadlines.signal, redirect: 'manual' }));
    if (isRedirect(res)) {
      res.body?.cancel().catch(noop);
      return { kind: 'redirect' };
    }
    const text = await readCapped(res, limits.maxBytes, deadlines);
    if (text === null && res.ok) return { kind: 'too-large' };
    return { kind: 'response', status: res.status, text: text ?? '', requestId: requestIdOf(res) };
  } catch {
    return deadlines.reason ? { kind: 'cut', reason: deadlines.reason } : { kind: 'network' };
  } finally {
    deadlines.release();
  }
}

/**
 * Which client an attempt authorizes as. Chosen at start from the saved registration and kept with the pending attempt:
 * a new registration goes through `dynamic_agent_client`; a returning account uses its issued id.
 */
export type ClientMode =
  | { kind: 'dynamic' }
  | {
      kind: 'issued';
      clientId: IssuedClientId;
      /** Email from this account's last verified ID token. `id_token_hint` is never sent: the URL is handed to the browser. */
      loginHint: string | null;
    };

/** Fresh per attempt. `state` and `nonce` go into the URL; `verifier` stays server-side until the exchange. */
export interface AttemptSecrets {
  state: string;
  nonce: string;
  verifier: string;
}

const base64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export function newAttemptSecrets(): AttemptSecrets {
  return { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
}

/** base64url(SHA-256(verifier)) without padding (RFC 7636, S256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export interface AuthorizeRequest {
  client: ClientMode;
  hostId: HostId;
  redirectUri: LoopbackRedirectUri;
  secrets: AttemptSecrets;
  /** Only when the user explicitly asks to enable plan usage after a decline (docs: errors-and-recovery). */
  forceConsent: boolean;
}

export async function authorizeUrl(a: AuthorizeRequest): Promise<string> {
  const q = new URLSearchParams();
  if (a.client.kind === 'dynamic') {
    q.set('client_id', DYNAMIC_CLIENT);
    q.set('agent_name_hint', AGENT_NAME);
  } else {
    q.set('client_id', a.client.clientId);
    if (a.client.loginHint) q.set('login_hint', a.client.loginHint);
  }
  q.set('ext_agent_host_id', a.hostId);
  q.set('response_type', 'code');
  q.set('redirect_uri', a.redirectUri);
  q.set('scope', REQUESTED_SCOPES.join(' '));
  q.set('resource', RESOURCE);
  q.set('state', a.secrets.state);
  q.set('nonce', a.secrets.nonce);
  q.set('code_challenge_method', 'S256');
  q.set('code_challenge', await pkceChallenge(a.secrets.verifier));
  if (a.forceConsent) q.set('prompt', 'consent');
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/** The callback query, before `state` is matched to a pending attempt. */
export type CallbackQuery =
  | { kind: 'code'; state: string; code: string; clientId: string | null }
  /** `error=access_denied` and friends. `error` is a slug, or 'unknown' when upstream sent something else. */
  | { kind: 'error'; state: string; error: string };

const single = (q: URLSearchParams, name: string): string | null | undefined => {
  const all = q.getAll(name);
  if (all.length > 1) return undefined;
  return all[0] ?? null;
};

/** Pure. Null for anything that cannot be a callback: missing or repeated parameters, oversized values. */
export function parseCallbackQuery(query: URLSearchParams): CallbackQuery | null {
  const state = single(query, 'state');
  const code = single(query, 'code');
  const error = single(query, 'error');
  const clientId = single(query, 'client_id');
  if (state === undefined || code === undefined || error === undefined || clientId === undefined) return null;
  if (!state || state.length > 512) return null;
  if (error !== null) return { kind: 'error', state, error: upstreamCode(error) ?? 'unknown' };
  if (!code || code.length > 4096) return null;
  if (clientId !== null && clientId.length > 256) return null;
  return { kind: 'code', state, code, clientId };
}

/**
 * The client id to exchange the code with, or null to reject the callback. A new registration must return an issued
 * `oaiapp_…` id. A reauthorization may omit it, and a different one is rejected rather than replacing the registration.
 */
export function callbackClientId(mode: ClientMode, returned: string | null): IssuedClientId | null {
  if (mode.kind === 'dynamic') return parseIssuedClientId(returned);
  return returned === null || returned === mode.clientId ? mode.clientId : null;
}

/** A token-endpoint success, parsed. No ID token: it is verified once at sign-in and never kept or sent anywhere. */
export interface TokenGrant {
  accessToken: AccessToken;
  /** Required on exchange and on every refresh: a refresh without a replacement is an invalid response, never a reuse. */
  refreshToken: RefreshToken;
  expiresAt: number;
  /** Earliest suggested refresh time in epoch ms, or null when absent or unreadable. */
  earliestRefreshAt: number | null;
  /** Null when the answer carried no `scope`. On refresh that keeps the previous scopes; on exchange it is refused. */
  scopes: readonly string[] | null;
}
export type GrantedTokens = TokenGrant & { scopes: readonly string[] };

export type TokenFailure =
  /** Refresh only. The refresh token is unusable: clear it and sign in again with the saved client id. */
  | { kind: 'terminal' }
  /** Exchange only (`invalid_grant`). Discard the code and start a fresh authorization, keeping the issued client id. */
  | { kind: 'code-rejected' }
  /** The registration itself was refused. */
  | { kind: 'invalid-client' }
  /** Any other 4xx. Not proof the credentials are dead, so they are kept; the same request is not repeated. */
  | { kind: 'rejected'; status: number; code: string | null }
  /** Network, timeout, abort, 429, 5xx or a redirect. Credentials are kept. */
  | { kind: 'transient' }
  /** A 2xx whose body we cannot trust (not bearer, no refresh token, no scope on exchange, bad numbers). */
  | { kind: 'invalid-response' };
export type ExchangeFailure = Exclude<TokenFailure, { kind: 'terminal' }>;
export type RefreshFailure = Exclude<TokenFailure, { kind: 'code-rejected' }>;

/**
 * Only the fields a grant cannot work without are strict. The rest are read leniently: a refresh answer already rotated
 * the old token away, so refusing it over a field we do not use (a null `id_token`, an odd `earliest_refresh_at`) would
 * throw away the only valid refresh token.
 */
const TokenResponseSchema = z.object({
  access_token: AccessTokenSchema,
  refresh_token: RefreshTokenSchema,
  token_type: z.string().refine((t) => t.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(366 * 86_400),
  id_token: z.unknown().optional(),
  scope: z.unknown().optional(),
  earliest_refresh_at: z.unknown().optional(),
});
const OrphanSchema = z.object({ refresh_token: RefreshTokenSchema });
const OAuthErrorSchema = z.object({ error: z.string() });
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const IdTokenTextSchema = z.string().min(1).max(MAX_TOKEN_CHARS);
const ScopeTextSchema = z.string().max(4096);

/**
 * The official token reference lists `earliest_refresh_at` without a type or unit. T3 (bb646d2, CodexChatGptAuth.ts:509)
 * and the official devkit (index.ts:100) both read a number as Unix seconds and a string with Date.parse, so this does
 * the same, accepting only ISO 8601 strings. A number of 1e11 or more would be year 5138 in seconds and is most likely
 * milliseconds; guessing would either block refresh for millennia or misplace it, so it is dropped (null), as is any
 * other unreadable value. Null means "no lower bound", which is what an absent field means too.
 */
function earliestRefreshAt(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 && raw < 1e11 ? Math.round(raw * 1000) : null;
  if (typeof raw === 'string' && IsoDateTimeSchema.safeParse(raw).success) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function scopeList(raw: unknown): string[] | null {
  const scope = ScopeTextSchema.safeParse(raw);
  return scope.success ? scope.data.split(/\s+/).filter(Boolean) : null;
}

type TokenAnswer<F> = { ok: true; grant: TokenGrant; idToken: string | null } | { ok: false; failure: F; orphan: RefreshToken | null };

async function tokenRequest<F extends TokenFailure>(
  http: OutboundFetch,
  form: Record<string, string>,
  classify: (code: string | null, status: number) => F,
  now: number,
  signal: AbortSignal,
): Promise<TokenAnswer<F | { kind: 'transient' } | { kind: 'invalid-response' }>> {
  const r = await sendBounded(
    http,
    {
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    },
    { signal, timeoutMs: OAUTH_TIMEOUT_MS, maxBytes: TOKEN_BODY_BYTES },
  );
  if (r.kind !== 'response') return { ok: false, failure: { kind: r.kind === 'too-large' ? 'invalid-response' : 'transient' }, orphan: null };
  if (r.status === 429 || r.status >= 500) return { ok: false, failure: { kind: 'transient' }, orphan: null };
  const json = parseJson(r.text);
  if (r.status < 200 || r.status >= 300) {
    const err = OAuthErrorSchema.safeParse(json);
    return { ok: false, failure: classify(err.success ? upstreamCode(err.data.error) : null, r.status), orphan: null };
  }
  const body = TokenResponseSchema.safeParse(json);
  if (!body.success) {
    const orphan = OrphanSchema.safeParse(json);
    return { ok: false, failure: { kind: 'invalid-response' }, orphan: orphan.success ? orphan.data.refresh_token : null };
  }
  const t = body.data;
  const idToken = IdTokenTextSchema.safeParse(t.id_token);
  return {
    ok: true,
    idToken: idToken.success ? idToken.data : null,
    grant: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: now + t.expires_in * 1000,
      earliestRefreshAt: earliestRefreshAt(t.earliest_refresh_at),
      scopes: scopeList(t.scope),
    },
  };
}

const common4xx = (code: string | null, status: number): { kind: 'invalid-client' } | { kind: 'rejected'; status: number; code: string | null } =>
  code === 'invalid_client' ? { kind: 'invalid-client' } : { kind: 'rejected', status, code };

/**
 * Refresh with the issued client id. No `scope` is sent, which keeps the grant (docs: profiles-and-sessions). On failure,
 * `orphan` is a replacement token the server issued in an answer we refused; revoke it.
 */
export async function refreshGrant(
  http: OutboundFetch,
  a: { clientId: IssuedClientId; refreshToken: RefreshToken; now: number; signal: AbortSignal },
): Promise<{ ok: true; grant: TokenGrant } | { ok: false; failure: RefreshFailure; orphan: RefreshToken | null }> {
  const r = await tokenRequest(
    http,
    { grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: RESOURCE },
    (code, status): RefreshFailure => (code !== null && TERMINAL_REFRESH_CODES.has(code) ? { kind: 'terminal' } : common4xx(code, status)),
    a.now,
    a.signal,
  );
  return r.ok ? { ok: true, grant: r.grant } : r;
}

export type RefreshDecision = { kind: 'use' } | { kind: 'refresh' };

/** Refresh near expiry. Honor the suggested refresh time only while the access token remains valid. */
export function refreshDecision(c: { expiresAt: number; earliestRefreshAt: number | null }, now: number): RefreshDecision {
  if (c.expiresAt <= now) return { kind: 'refresh' };
  if (c.expiresAt - now > REFRESH_MARGIN_MS) return { kind: 'use' };
  if (c.earliestRefreshAt !== null && c.earliestRefreshAt > now) return { kind: 'use' };
  return { kind: 'refresh' };
}

export const hasPlanScope = (scopes: readonly string[]): boolean => scopes.includes(PLAN_SCOPE);

export interface VerifiedIdentity {
  subject: Subject;
  email: string | null;
}

export type IdTokenProblem =
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'nonce-mismatch'
  | 'malformed'
  /** Discovery or JWKS could not be fetched. Start a fresh authorization after recovery. */
  | 'keys-unavailable'
  /** Discovery answered with something we refuse: another issuer, off-origin endpoints, or no allowed algorithm. */
  | 'directory-invalid';

const isIssuerUrl = (u: string): boolean => {
  try {
    const url = new URL(u);
    return url.origin === ISSUER && !url.username && !url.password;
  } catch {
    return false;
  }
};
const IssuerUrlSchema = z.string().max(2048).refine(isIssuerUrl);
const DiscoverySchema = z.object({
  issuer: z.literal(ISSUER),
  jwks_uri: IssuerUrlSchema,
  revocation_endpoint: IssuerUrlSchema,
  id_token_signing_alg_values_supported: z.array(z.string().max(32)).max(64),
});
const PublicJwkSchema = z.object({
  kty: z.enum(['RSA', 'EC']),
  kid: z.string().max(256).optional(),
  use: z.string().max(16).optional(),
  alg: z.string().max(32).optional(),
  key_ops: z.array(z.string().max(32)).max(16).optional(),
  n: z.string().max(4096).optional(),
  e: z.string().max(64).optional(),
  crv: z.string().max(16).optional(),
  x: z.string().max(256).optional(),
  y: z.string().max(256).optional(),
});
const JwksSchema = z.object({ keys: z.array(z.unknown()).max(100) });
const IdClaimsSchema = z.object({
  sub: SubjectSchema,
  nonce: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.unknown().optional(),
  email: z.unknown().optional(),
});
const EmailSchema = z.string().min(1).max(320);

interface Metadata {
  jwksUri: string;
  revocationEndpoint: string;
  algorithms: JWSAlgorithm[];
}
type Fetched<T> = { ok: true; value: T } | { ok: false; problem: 'keys-unavailable' | 'directory-invalid' };

async function getJson(http: OutboundFetch, url: string, signal: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false }> {
  const r = await sendBounded(http, { url, method: 'GET', headers: { accept: 'application/json' } }, { signal, timeoutMs: OAUTH_TIMEOUT_MS, maxBytes: DIRECTORY_BODY_BYTES });
  return r.kind === 'response' && r.status === 200 ? { ok: true, json: parseJson(r.text) } : { ok: false };
}

function joseProblem(e: unknown): IdTokenProblem {
  if (e instanceof joseErrors.JWTExpired) return 'expired';
  if (e instanceof joseErrors.JWTClaimValidationFailed) return e.claim === 'iss' ? 'wrong-issuer' : e.claim === 'aud' ? 'wrong-audience' : 'malformed';
  if (e instanceof joseErrors.JWSSignatureVerificationFailed || e instanceof joseErrors.JOSEAlgNotAllowed || e instanceof joseErrors.JWKSNoMatchingKey) return 'bad-signature';
  if (e instanceof joseErrors.JOSENotSupported || e instanceof joseErrors.JWKSMultipleMatchingKeys) return 'bad-signature';
  return 'malformed';
}

/**
 * OpenAI's discovery document and JWKS, cached for an hour. Discovery must name ISSUER and keep every endpoint on its
 * origin. Algorithms are discovery's published list intersected with ALLOWED_ID_TOKEN_ALGS. Keys come only from the
 * discovered `jwks_uri`, never from a token header (`jku`, `x5u` and embedded keys are ignored). An unknown `kid`
 * refetches the JWKS once per verification.
 */
export class OpenAiDirectory {
  readonly #http: OutboundFetch;
  readonly #now: () => number;
  #metadata: { value: Metadata; at: number } | null = null;
  #keys: { value: ReturnType<typeof createLocalJWKSet>; at: number } | null = null;

  constructor(deps: { http: OutboundFetch; now: () => number }) {
    this.#http = deps.http;
    this.#now = deps.now;
  }

  async revocationEndpoint(signal: AbortSignal): Promise<Fetched<string>> {
    const m = await this.#loadMetadata(signal);
    return m.ok ? { ok: true, value: m.value.revocationEndpoint } : m;
  }

  /** Checks signature, issuer, audience (the issued client id), expiry and nonce, then reads `sub` and `email`. */
  async verifyIdToken(
    idToken: string,
    expect: { clientId: IssuedClientId; nonce: string },
    signal: AbortSignal,
  ): Promise<{ ok: true; identity: VerifiedIdentity } | { ok: false; problem: IdTokenProblem }> {
    const metadata = await this.#loadMetadata(signal);
    if (!metadata.ok) return metadata;
    let keys = await this.#loadKeys(metadata.value, signal, false);
    if (!keys.ok) return keys;
    const verify = (k: ReturnType<typeof createLocalJWKSet>) =>
      jwtVerify(idToken, k, {
        issuer: ISSUER,
        audience: expect.clientId,
        algorithms: metadata.value.algorithms,
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        clockTolerance: CLOCK_TOLERANCE_S,
        currentDate: new Date(this.#now()),
      });
    let payload: unknown;
    try {
      payload = (await verify(keys.value)).payload;
    } catch (e) {
      if (!(e instanceof joseErrors.JWKSNoMatchingKey)) return { ok: false, problem: joseProblem(e) };
      keys = await this.#loadKeys(metadata.value, signal, true);
      if (!keys.ok) return keys;
      try {
        payload = (await verify(keys.value)).payload;
      } catch (e2) {
        return { ok: false, problem: joseProblem(e2) };
      }
    }
    const claims = IdClaimsSchema.safeParse(payload);
    if (!claims.success) return { ok: false, problem: 'malformed' };
    const c = claims.data;
    if (c.nonce !== expect.nonce) return { ok: false, problem: 'nonce-mismatch' };
    // OIDC Core 3.1.3.7: with several audiences, or any azp at all, azp must be this client.
    const several = Array.isArray(c.aud) && c.aud.length > 1;
    if ((several || c.azp !== undefined) && c.azp !== expect.clientId) return { ok: false, problem: 'wrong-audience' };
    const email = EmailSchema.safeParse(c.email);
    return { ok: true, identity: { subject: c.sub, email: email.success ? email.data : null } };
  }

  async #loadMetadata(signal: AbortSignal): Promise<Fetched<Metadata>> {
    const now = this.#now();
    if (this.#metadata && now - this.#metadata.at < DIRECTORY_TTL_MS) return { ok: true, value: this.#metadata.value };
    const r = await getJson(this.#http, DISCOVERY_URL, signal);
    if (!r.ok) return { ok: false, problem: 'keys-unavailable' };
    const d = DiscoverySchema.safeParse(r.json);
    if (!d.success) return { ok: false, problem: 'directory-invalid' };
    const published = new Set(d.data.id_token_signing_alg_values_supported);
    const algorithms = ALLOWED_ID_TOKEN_ALGS.filter((a) => published.has(a));
    if (algorithms.length === 0) return { ok: false, problem: 'directory-invalid' };
    const value: Metadata = { jwksUri: d.data.jwks_uri, revocationEndpoint: d.data.revocation_endpoint, algorithms };
    this.#metadata = { value, at: now };
    return { ok: true, value };
  }

  async #loadKeys(metadata: Metadata, signal: AbortSignal, force: boolean): Promise<Fetched<ReturnType<typeof createLocalJWKSet>>> {
    const now = this.#now();
    if (!force && this.#keys && now - this.#keys.at < DIRECTORY_TTL_MS) return { ok: true, value: this.#keys.value };
    const r = await getJson(this.#http, metadata.jwksUri, signal);
    if (!r.ok) return { ok: false, problem: 'keys-unavailable' };
    const set = JwksSchema.safeParse(r.json);
    if (!set.success) return { ok: false, problem: 'directory-invalid' };
    const jwks: JSONWebKeySet = { keys: set.data.keys.flatMap((k) => { const p = PublicJwkSchema.safeParse(k); return p.success ? [p.data] : []; }) };
    const value = createLocalJWKSet(jwks);
    this.#keys = { value, at: now };
    return { ok: true, value };
  }
}

export type SignInFailure =
  | { kind: 'token'; failure: ExchangeFailure }
  | { kind: 'no-id-token' }
  | { kind: 'identity'; problem: IdTokenProblem }
  /** The grant lacks `chatgpt.tokens.use.direct`: consent was declined or plan use is off. No inference on this path. */
  | { kind: 'plan-not-granted'; identity: VerifiedIdentity };

export type SignInOutcome =
  | { ok: true; clientId: IssuedClientId; identity: VerifiedIdentity; grant: GrantedTokens }
  /** `orphan` is a refresh token that was issued but not accepted. The caller revokes it; nothing else holds it. */
  | { ok: false; failure: SignInFailure; orphan: RefreshToken | null };

/**
 * The connection boundary. Exchanges the code, verifies the ID token against the attempt's nonce and client id, and
 * requires the plan scope. Only a fully validated result carries tokens forward. Comparing `identity.subject` with a saved
 * registration is the caller's job, since only it knows which account the attempt was meant for.
 */
export async function completeSignIn(
  http: OutboundFetch,
  directory: OpenAiDirectory,
  a: { clientId: IssuedClientId; code: string; verifier: string; redirectUri: LoopbackRedirectUri; nonce: string; now: number; signal: AbortSignal },
): Promise<SignInOutcome> {
  const r = await tokenRequest(
    http,
    { grant_type: 'authorization_code', client_id: a.clientId, code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri, resource: RESOURCE },
    (code, status): ExchangeFailure => (code === 'invalid_grant' ? { kind: 'code-rejected' } : common4xx(code, status)),
    a.now,
    a.signal,
  );
  if (!r.ok) return { ok: false, failure: { kind: 'token', failure: r.failure }, orphan: r.orphan };
  const { grant, idToken } = r;
  const fail = (failure: SignInFailure): SignInOutcome => ({ ok: false, failure, orphan: grant.refreshToken });
  if (grant.scopes === null) return fail({ kind: 'token', failure: { kind: 'invalid-response' } });
  if (idToken === null) return fail({ kind: 'no-id-token' });
  const verified = await directory.verifyIdToken(idToken, { clientId: a.clientId, nonce: a.nonce }, a.signal);
  if (!verified.ok) return fail({ kind: 'identity', problem: verified.problem });
  if (!hasPlanScope(grant.scopes)) return fail({ kind: 'plan-not-granted', identity: verified.identity });
  return { ok: true, clientId: a.clientId, identity: verified.identity, grant: { ...grant, scopes: grant.scopes } };
}

export type RevokeResult = 'revoked' | 'transient' | 'rejected';

/** One attempt; the caller retries 'transient' with backoff. An empty 200 is success, also for an already-invalid token. */
export async function revokeRefreshToken(
  http: OutboundFetch,
  directory: OpenAiDirectory,
  a: { clientId: IssuedClientId; refreshToken: RefreshToken; signal: AbortSignal },
): Promise<RevokeResult> {
  const endpoint = await directory.revocationEndpoint(a.signal);
  if (!endpoint.ok) return endpoint.problem === 'keys-unavailable' ? 'transient' : 'rejected';
  const r = await sendBounded(
    http,
    {
      url: endpoint.value,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }).toString(),
    },
    { signal: a.signal, timeoutMs: OAUTH_TIMEOUT_MS, maxBytes: REVOKE_BODY_BYTES },
  );
  if (r.kind !== 'response') return 'transient';
  if (r.status === 200) return 'revoked';
  return r.status === 429 || r.status >= 500 ? 'transient' : 'rejected';
}
