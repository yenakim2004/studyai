import { z } from 'zod';
import {
  authorizeUrl,
  callbackClientId,
  completeSignIn,
  hasPlanScope,
  newAttemptSecrets,
  newHostId,
  OpenAiDirectory,
  parseAccessToken,
  parseHostId,
  parseIssuedClientId,
  parseLoopbackRedirectUri,
  parseRefreshToken,
  parseSubject,
  refreshDecision,
  refreshGrant,
  revokeRefreshToken,
  type AccessToken,
  type CallbackQuery,
  type ClientMode,
  type HostId,
  type IssuedClientId,
  type OutboundFetch,
  type RefreshToken,
  type SignInFailure,
  type VerifiedIdentity,
} from '../../src/core/chatgpt/oauth';
import { DEFAULT_STREAM_TIMING, listModels, parseModelSlug, streamResponse, type ModelSlug, type ResponsesFailure, type StreamTiming } from '../../src/core/chatgpt/responses';
import { CHATGPT_REPLY, FAILURE_CODE, GATE_REASON, PAUSE_SENTENCE, type ChatGptCode, type StartRefusal } from '../../src/core/chatgpt/messages';
import { AI_OUTPUT_CAP, SIGN_IN_OUTCOMES, type AiReply, type AiStatus, type AiTask, type ChatGptConnection, type ChatGptModel, type ChatGptNotice, type ChatGptPauseCode, type SignInOutcome } from '../../src/core/tutor/contract';
import { buildAiRequest } from '../../src/core/tutor/prompts';
import { constantTimeEqual, fromBase64Url, sha256Hex, toBase64Url } from './encoding';
import type { Loopback } from './loopback';

/**
 * The single owner of the ChatGPT account on this server: registration, sealed credentials, the pending sign-in, the model
 * catalog, the pause and the in-memory refresh. It imports nothing from Cloudflare. The Durable Object hands it a
 * synchronous key-value store, so the race tests run in Node over a Map.
 *
 * The DO runs one request at a time between awaits, but accepts other calls while this class awaits the network or
 * WebCrypto. So every write that depends on something read before an await is made in a synchronous section that re-checks
 * the identity it belongs to:
 *  - `intent` names the latest sign-in start. A newer start or a disconnect replaces or deletes it, and every later write
 *    of an older attempt (pending row, registration, notice, credentials) is dropped.
 *  - `rev` names one stored token set and changes on every write, refreshes included. A refresh, a 401 recheck and a
 *    terminal clear only act while the stored rev is still the one they read.
 *  - `generation` names one session (sign-in, disconnect, terminal clear). Pause and model catalog belong to one session.
 *  - `op` names the latest start or disconnect, so a slow revocation cannot overwrite a newer notice.
 */

export interface SyncKv {
  get(k: string): string | undefined;
  put(k: string, v: string): void;
  del(k: string): void;
}

export interface ChatGptDeps {
  kv: SyncKv;
  http: OutboundFetch;
  /** Raw CHATGPT_SEAL_KEY: base64url of 32 random bytes. Anything else disables ChatGPT on this server. */
  sealKey: string | undefined;
  loopback: Loopback | null;
  now: () => number;
  /** Rewrites the authorize URL the browser follows. Identity in production; only the test DO points it at the e2e issuer. */
  browserUrl: (url: string) => string;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<Limits>;
}

interface Limits {
  /** The whole ask, from before the token check to the last stream byte. Below the browser's 180 s. */
  askDeadlineMs: number;
  maxConcurrent: number;
  pendingTtlMs: number;
  /** One sign-in completion: code exchange, discovery, keys. */
  signInDeadlineMs: number;
  /** One shared refresh. Its own deadline: no single ask may cancel it after upstream has rotated the token. */
  refreshDeadlineMs: number;
  stream: StreamTiming;
  revokeDelaysMs: readonly number[];
  revokeTotalMs: number;
}

const DEFAULT_LIMITS: Limits = {
  askDeadlineMs: 170_000,
  maxConcurrent: 2,
  pendingTtlMs: 10 * 60_000,
  signInDeadlineMs: 60_000,
  refreshDeadlineMs: 30_000,
  stream: DEFAULT_STREAM_TIMING,
  revokeDelaysMs: [0, 500, 1_500],
  revokeTotalMs: 20_000,
};

const K = {
  host: 'chatgpt:host',
  registration: 'chatgpt:registration',
  generation: 'chatgpt:generation',
  creds: 'chatgpt:creds',
  pending: 'chatgpt:pending',
  intent: 'chatgpt:intent',
  op: 'chatgpt:op',
  notice: 'chatgpt:notice',
  model: 'chatgpt:model',
  models: 'chatgpt:models',
  pause: 'chatgpt:pause',
} as const;

/** Every key this class owns. The DO's test reset and any audit of stored data use this list. */
export const CHATGPT_KEYS: readonly string[] = Object.values(K);

const RevSchema = z.string().uuid().brand<'Rev'>();
const AttemptIdSchema = z.string().uuid().brand<'AttemptId'>();
/** One stored token set. Minted per write, refreshes included. */
type Rev = z.output<typeof RevSchema>;
/** One sign-in start. */
type AttemptId = z.output<typeof AttemptIdSchema>;
const newRev = (): Rev => RevSchema.parse(crypto.randomUUID());
const newAttemptId = (): AttemptId => AttemptIdSchema.parse(crypto.randomUUID());

const clientIdSchema = z.string().transform((v, ctx) => parseIssuedClientId(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER));
const subjectSchema = z.string().transform((v, ctx) => parseSubject(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER));

const RegistrationSchema = z.object({ clientId: clientIdSchema, subject: subjectSchema.nullable(), email: z.string().max(320).nullable(), planDisabled: z.boolean() });
type Registration = z.output<typeof RegistrationSchema>;

/** The client id stays in clear: whether a live session of that client remains decides revocation synchronously. */
const CredsRowSchema = z.object({ generation: z.number().int(), rev: RevSchema, clientId: clientIdSchema, sealed: z.string() });
type CredsRow = z.output<typeof CredsRowSchema>;

/** The sealed plaintext. Never leaves this module. There is no ID token: none is stored or sent anywhere. */
const CredentialsSchema = z.object({
  subject: subjectSchema,
  email: z.string().max(320).nullable(),
  accessToken: z.string().transform((v, ctx) => parseAccessToken(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER)),
  refreshToken: z.string().transform((v, ctx) => parseRefreshToken(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER)),
  expiresAt: z.number(),
  earliestRefreshAt: z.number().nullable(),
  /** Always contains the plan scope: a grant without it is never sealed. */
  scopes: z.array(z.string()).refine(hasPlanScope),
});
type Credentials = z.output<typeof CredentialsSchema>;

const PendingRowSchema = z.object({
  attemptId: AttemptIdSchema,
  stateHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.number(),
  /** `new` registers through the dynamic client (first sign-in or "another account"); `reauth` reuses the saved client. */
  purpose: z.enum(['new', 'reauth']),
  clientId: clientIdSchema.nullable(),
  loginHint: z.string().max(320).nullable(),
  redirectUri: z.string().transform((v, ctx) => parseLoopbackRedirectUri(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER)),
  sealed: z.string(),
});
type PendingRow = z.output<typeof PendingRowSchema>;
const PendingSecretSchema = z.object({ nonce: z.string().min(1), verifier: z.string().min(1) });

const PauseSchema = z.object({ generation: z.number().int(), code: z.enum(['usage-limit', 'not-eligible']), since: z.number() });
const ModelsRowSchema = z.object({ generation: z.number().int(), models: z.array(z.object({ slug: z.string(), displayName: z.string() })) });
const NoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sign-in'), outcome: z.string(), at: z.number() }),
  z.object({ kind: z.literal('session-ended'), reason: z.enum(['refresh-rejected', 'invalid-client', 'unreadable']), at: z.number() }),
  z.object({ kind: z.literal('disconnected'), remoteRevoked: z.boolean().nullable(), at: z.number() }),
]);

export type StartReply = { ok: true; authorizeUrl: string } | { ok: false; error: StartRefusal };
export type DisconnectReply = { ok: true; remoteRevoked: boolean };
export type ModelsReply = { ok: true; models: ChatGptModel[]; selected: string | null } | { ok: false; code: ChatGptCode; message: string };
export type SelectReply = { ok: true } | { ok: false; error: string };
export interface StartOptions {
  /** `other` registers a new client for a different ChatGPT account. The working session stays until that one succeeds. */
  account: 'current' | 'other';
  /** Asks OpenAI for the consent screen again, to enable plan use after it was declined. */
  forceConsent: boolean;
}

/** What the four AI screens see. Derived, never stored. */
export interface AiGate {
  state: 'off' | 'ready' | 'paused';
  reasons: string[];
}

type Granted = { token: AccessToken; rev: Rev; generation: number };
type AccessResult =
  | ({ ok: true } & Granted)
  /** `retry`: the token set changed under this request; nothing was refreshed or cleared. */
  | { ok: false; reason: 'signin-required' | 'unavailable' | 'retry' | 'aborted' };

/** Inference stops for one of these. Recorded, because the stream only ever sees "aborted". */
type Cut = 'deadline' | 'replaced' | 'ended';

export type SignInResult = { kind: 'granted' | 'plan-not-granted'; identity: VerifiedIdentity };

export interface SignInDecision {
  outcome: SignInOutcome;
  install: boolean;
  registration: Registration | 'keep';
  /** The new refresh token. Revoked only when no live session of the same client remains (same-client revocation may end siblings). */
  revokeNew: boolean;
  /** The replaced session's refresh token, under the same rule. */
  revokeOld: boolean;
}

/**
 * Pure. What one verified sign-in does to the account, given the state at its commit.
 *  - A reauth that verifies another `sub` changes nothing.
 *  - No plan scope while a session works changes nothing; with none, it records the account as plan-disabled, no tokens.
 *  - Otherwise the new session replaces the old one.
 */
export function decideSignIn(a: {
  purpose: 'new' | 'reauth';
  registration: Registration | null;
  liveClientId: IssuedClientId | null;
  attemptClientId: IssuedClientId;
  result: SignInResult;
}): SignInDecision {
  const sameClientLive = a.liveClientId === a.attemptClientId;
  const keep = (outcome: SignInOutcome): SignInDecision => ({ outcome, install: false, registration: 'keep', revokeNew: !sameClientLive, revokeOld: false });
  const known = a.purpose === 'reauth' && a.registration?.clientId === a.attemptClientId ? a.registration : null;
  const identity = a.result.identity;
  if (known?.subject && known.subject !== identity.subject) return keep('account-mismatch');
  if (a.result.kind === 'plan-not-granted') {
    if (a.liveClientId !== null) return keep('plan-not-enabled');
    return {
      outcome: 'plan-not-enabled',
      install: false,
      registration: { clientId: a.attemptClientId, subject: identity.subject, email: identity.email, planDisabled: true },
      revokeNew: true,
      revokeOld: false,
    };
  }
  return {
    outcome: 'connected',
    install: true,
    registration: { clientId: a.attemptClientId, subject: identity.subject, email: identity.email, planDisabled: false },
    revokeNew: false,
    revokeOld: a.liveClientId !== null && !sameClientLive,
  };
}

function signInFailureOutcome(f: SignInFailure): SignInOutcome {
  switch (f.kind) {
    case 'token':
      switch (f.failure.kind) {
        case 'code-rejected':
          return 'code-rejected';
        case 'invalid-client':
          return 'client-invalid';
        case 'transient':
          return 'upstream-unavailable';
        case 'rejected':
        case 'invalid-response':
          return 'code-rejected';
        default: {
          const exhaustive: never = f.failure;
          return exhaustive;
        }
      }
    case 'no-id-token':
      return 'id-token-invalid';
    case 'identity':
      return f.problem === 'keys-unavailable' ? 'upstream-unavailable' : 'id-token-invalid';
    case 'plan-not-granted':
      return 'plan-not-enabled';
    default: {
      const exhaustive: never = f;
      return exhaustive;
    }
  }
}

// ---- sealing ----------------------------------------------------------------------------------------------------------
// AES-256-GCM, `v1.<iv>.<ciphertext>`. The additional data binds a blob to its slot and to its row identity (rev or
// attempt id), so a sealed value copied into another row does not open. It protects against a copy of the state
// directory without the key, nothing more: the key sits next to it on the same disk.

function parseSealKeyBytes(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!raw) return null;
  const bytes = fromBase64Url(raw.trim());
  return bytes && bytes.length === 32 ? bytes : null;
}

async function seal(key: CryptoKey, aad: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(plaintext)));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

async function unseal(key: CryptoKey, aad: string, sealed: string): Promise<string | undefined> {
  const [v, ivText, ctText, ...rest] = sealed.split('.');
  if (v !== 'v1' || !ivText || !ctText || rest.length > 0) return undefined;
  const iv = fromBase64Url(ivText);
  const ct = fromBase64Url(ctText);
  if (!iv || iv.length !== 12 || !ct) return undefined;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, ct));
  } catch {
    return undefined;
  }
}

const credsAad = (rev: string) => `studyai/chatgpt/creds/v1/${rev}`;
const pendingAad = (attemptId: string) => `studyai/chatgpt/pending/v1/${attemptId}`;

const readJson = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** Settles with the promise, or with 'aborted' once the signal fires. The promise itself keeps running. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error('refresh failed'));
      },
    );
  });
}

const reply = (code: ChatGptCode, requestId: string | null = null): AiReply => ({
  ok: false,
  code,
  message: requestId ? `${CHATGPT_REPLY[code].message} (요청 ID: ${requestId})` : CHATGPT_REPLY[code].message,
});

export class ChatGptAccount {
  readonly #d: ChatGptDeps;
  readonly #limits: Limits;
  readonly #directory: OpenAiDirectory;
  readonly #sealBytes: Uint8Array<ArrayBuffer> | null;
  #sealKey: Promise<CryptoKey> | null = null;
  /** Single-flight refresh, keyed by the token set it refreshes. */
  #refreshing: { rev: Rev; promise: Promise<AccessResult> } | null = null;
  /** Inference in flight. Disconnect and replacement stop all of it. */
  readonly #inflight = new Map<AbortController, (cut: Cut) => void>();

  constructor(deps: ChatGptDeps) {
    this.#d = deps;
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.#directory = new OpenAiDirectory({ http: deps.http, now: deps.now });
    this.#sealBytes = parseSealKeyBytes(deps.sealKey);
  }

  // ---- read side: synchronous, no network, no decryption -------------------------------------------------------------

  status(): AiStatus {
    const reg = this.#registration();
    const row = this.#credsRow();
    let connection: ChatGptConnection;
    if (row) {
      const pause = this.#pause(row.generation);
      connection = { kind: 'connected', email: reg?.email ?? null, model: this.#selectedModel(row.generation), pause: pause ? { code: pause.code, since: pause.since } : null };
    } else if (reg?.planDisabled) connection = { kind: 'plan-disabled', email: reg.email };
    else connection = { kind: 'disconnected', registered: reg !== null, email: reg?.email ?? null };
    const pending = this.#pending();
    return {
      ...this.gate(),
      signInAvailable: this.#loopbackReady(),
      connection,
      pendingUntil: pending && pending.expiresAt > this.#d.now() && this.#d.kv.get(K.intent) === pending.attemptId ? pending.expiresAt : null,
      notice: this.#notice(),
    };
  }

  gate(): AiGate {
    if (!this.#sealBytes) return { state: 'off', reasons: [GATE_REASON['not-configured']] };
    const row = this.#credsRow();
    if (row) {
      const pause = this.#pause(row.generation);
      return pause ? { state: 'paused', reasons: [PAUSE_SENTENCE[pause.code]] } : { state: 'ready', reasons: [] };
    }
    if (this.#registration()?.planDisabled) return { state: 'off', reasons: [GATE_REASON['plan-disabled']] };
    return { state: 'off', reasons: [this.#notice()?.kind === 'session-ended' ? GATE_REASON.ended : GATE_REASON.disconnected] };
  }

  // ---- sign-in ----------------------------------------------------------------------------------------------------------

  async start(o: StartOptions): Promise<StartReply> {
    const lb = this.#d.loopback;
    if (!lb) return { ok: false, error: 'loopback-only' };
    if (!this.#sealBytes) return { ok: false, error: 'not-configured' };
    const kv = this.#d.kv;
    const attemptId = newAttemptId();
    kv.put(K.intent, attemptId);
    kv.del(K.pending);
    this.#bumpOp();
    const hostId = this.#hostId();
    const reg = this.#registration();
    const client: ClientMode = o.account === 'other' || !reg ? { kind: 'dynamic' } : { kind: 'issued', clientId: reg.clientId, loginHint: reg.email };
    const secrets = newAttemptSecrets();
    const key = await this.#key();
    const [url, stateHash, sealed] = await Promise.all([
      authorizeUrl({ client, hostId, redirectUri: lb.redirectUri, secrets, forceConsent: o.forceConsent }),
      sha256Hex(secrets.state),
      seal(key, pendingAad(attemptId), JSON.stringify({ nonce: secrets.nonce, verifier: secrets.verifier })),
    ]);
    if (kv.get(K.intent) !== attemptId) return { ok: false, error: 'superseded' };
    const row: PendingRow = {
      attemptId,
      stateHash,
      expiresAt: this.#d.now() + this.#limits.pendingTtlMs,
      purpose: client.kind === 'dynamic' ? 'new' : 'reauth',
      clientId: client.kind === 'issued' ? client.clientId : null,
      loginHint: client.kind === 'issued' ? client.loginHint : null,
      redirectUri: lb.redirectUri,
      sealed,
    };
    kv.put(K.pending, JSON.stringify(row));
    return { ok: true, authorizeUrl: this.#d.browserUrl(url) };
  }

  /** One callback. Single-use: the pending row is consumed before any network call, and a junk state writes nothing. */
  async callback(q: CallbackQuery | null): Promise<SignInOutcome> {
    if (!q || !this.#loopbackReady()) return 'unknown-attempt';
    const kv = this.#d.kv;
    const stateHash = await sha256Hex(q.state);
    const row = this.#pending();
    if (!row || !constantTimeEqual(row.stateHash, stateHash) || kv.get(K.intent) !== row.attemptId) return 'unknown-attempt';
    kv.del(K.pending);
    const attemptId = row.attemptId;
    const settle = (outcome: SignInOutcome): SignInOutcome => {
      if (kv.get(K.intent) !== attemptId) return 'superseded';
      kv.del(K.intent);
      this.#putNotice({ kind: 'sign-in', outcome, at: this.#d.now() });
      return outcome;
    };
    if (this.#d.now() >= row.expiresAt) return settle('expired');
    if (q.kind === 'error') return settle(q.error === 'access_denied' ? 'denied' : 'upstream-unavailable');
    const mode: ClientMode = row.purpose === 'reauth' && row.clientId ? { kind: 'issued', clientId: row.clientId, loginHint: row.loginHint } : { kind: 'dynamic' };
    const clientId = callbackClientId(mode, q.clientId);
    if (!clientId) return settle(mode.kind === 'dynamic' ? 'registration-incomplete' : 'client-mismatch');
    // A first registration keeps its issued client even if the exchange fails, so the retry does not register again.
    if (row.purpose === 'new' && !this.#registration()) kv.put(K.registration, JSON.stringify({ clientId, subject: null, email: null, planDisabled: false }));

    const key = await this.#key();
    const secret = PendingSecretSchema.safeParse(readJson(await unseal(key, pendingAad(attemptId), row.sealed)));
    if (!secret.success) return settle('unknown-attempt');
    const done = await completeSignIn(this.#d.http, this.#directory, {
      clientId,
      code: q.code,
      verifier: secret.data.verifier,
      redirectUri: row.redirectUri,
      nonce: secret.data.nonce,
      now: this.#d.now(),
      signal: AbortSignal.timeout(this.#limits.signInDeadlineMs),
    });

    let result: SignInResult;
    if (done.ok) result = { kind: 'granted', identity: done.identity };
    else if (done.failure.kind === 'plan-not-granted') result = { kind: 'plan-not-granted', identity: done.failure.identity };
    else {
      const outcome = signInFailureOutcome(done.failure);
      // A dead client id must not be reused, unless a live session still runs on it (that session ends on its own refresh).
      if (kv.get(K.intent) === attemptId && outcome === 'client-invalid' && this.#registration()?.clientId === clientId && this.#credsRow()?.clientId !== clientId) kv.del(K.registration);
      const settled = settle(outcome);
      if (done.orphan) this.#revokeIfOrphan(clientId, done.orphan);
      return settled;
    }

    const newRefresh = done.ok ? done.grant.refreshToken : done.orphan;
    let sealedCreds: { rev: Rev; sealed: string } | null = null;
    if (done.ok) {
      const creds: Credentials = {
        subject: done.identity.subject,
        email: done.identity.email,
        accessToken: done.grant.accessToken,
        refreshToken: done.grant.refreshToken,
        expiresAt: done.grant.expiresAt,
        earliestRefreshAt: done.grant.earliestRefreshAt,
        scopes: [...done.grant.scopes],
      };
      const rev = newRev();
      sealedCreds = { rev, sealed: await seal(key, credsAad(rev), JSON.stringify(creds)) };
    }

    if (kv.get(K.intent) !== attemptId) {
      if (newRefresh) this.#revokeIfOrphan(clientId, newRefresh);
      return 'superseded';
    }
    const old = this.#credsRow();
    const decision = decideSignIn({ purpose: row.purpose, registration: this.#registration(), liveClientId: old?.clientId ?? null, attemptClientId: clientId, result });
    if (decision.registration !== 'keep') kv.put(K.registration, JSON.stringify(decision.registration));
    if (decision.install && sealedCreds) {
      const generation = this.#bumpGeneration();
      kv.put(K.creds, JSON.stringify({ generation, rev: sealedCreds.rev, clientId, sealed: sealedCreds.sealed }));
      kv.del(K.models);
      kv.del(K.pause);
      this.#stopInflight('replaced');
    }
    const outcome = settle(decision.outcome);
    if (decision.revokeNew && newRefresh) this.#revokeIfOrphan(clientId, newRefresh);
    if (decision.revokeOld && old) void this.#revokeRow(old);
    return outcome;
  }

  /** Local state is cleared first, in one synchronous step, so the disconnect wins every race. Revocation follows from memory. */
  async disconnect(o: { forget: boolean }): Promise<DisconnectReply> {
    const kv = this.#d.kv;
    const row = this.#credsRow();
    for (const k of [K.creds, K.pending, K.intent, K.pause, K.models]) kv.del(k);
    if (o.forget) {
      kv.del(K.registration);
      kv.del(K.model);
    }
    this.#bumpGeneration();
    this.#stopInflight('replaced');
    const op = this.#bumpOp();
    if (!row) return { ok: true, remoteRevoked: true };
    this.#putNotice({ kind: 'disconnected', remoteRevoked: null, at: this.#d.now() });
    const remoteRevoked = await this.#revokeRow(row);
    if (kv.get(K.op) === op) this.#putNotice({ kind: 'disconnected', remoteRevoked, at: this.#d.now() });
    return { ok: true, remoteRevoked };
  }

  // ---- use -------------------------------------------------------------------------------------------------------------

  async models(): Promise<ModelsReply> {
    const signal = AbortSignal.timeout(this.#limits.signInDeadlineMs);
    const r = await this.#catalog(signal);
    if (!r.ok) return { ok: false, code: r.code, message: CHATGPT_REPLY[r.code].message };
    const row = this.#credsRow();
    return { ok: true, models: r.models, selected: row ? (this.#selectedModel(row.generation)?.slug ?? null) : null };
  }

  selectModel(raw: unknown): SelectReply {
    const slug = parseModelSlug(raw);
    const row = this.#credsRow();
    if (!slug || !row) return { ok: false, error: 'ChatGPT가 연결되어 있지 않습니다.' };
    if (!this.#cachedModels(row.generation)?.some((m) => m.slug === slug)) return { ok: false, error: '이 계정의 모델 목록에 없는 모델입니다. 목록을 새로 고친 뒤 다시 고르세요.' };
    this.#d.kv.put(K.model, slug);
    return { ok: true };
  }

  resume(): void {
    this.#d.kv.del(K.pause);
  }

  /** One AI task on the plan. Never resends a request on its own. */
  async ask(task: AiTask): Promise<AiReply> {
    const gate = this.gate();
    if (gate.state !== 'ready') {
      if (gate.state === 'paused') return reply('chatgpt-paused');
      if (!this.#sealBytes) return reply('chatgpt-not-configured');
      return reply(this.#registration()?.planDisabled ? 'chatgpt-plan-disabled' : 'chatgpt-signin-required');
    }
    if (this.#inflight.size >= this.#limits.maxConcurrent) return reply('chatgpt-busy');
    const ctl = new AbortController();
    let cut: Cut | null = null;
    const stop = (c: Cut) => {
      cut ??= c;
      ctl.abort();
    };
    this.#inflight.set(ctl, stop);
    const deadlineAt = this.#d.now() + this.#limits.askDeadlineMs;
    const timer = setTimeout(() => stop('deadline'), this.#limits.askDeadlineMs);
    const aborted = (): AiReply => reply(cut === 'deadline' ? 'chatgpt-timeout' : cut === 'ended' ? 'chatgpt-signin-required' : 'chatgpt-aborted');
    try {
      const access = await this.#access({ signal: ctl.signal });
      if (!access.ok) return access.reason === 'aborted' || ctl.signal.aborted ? aborted() : this.#accessReply(access.reason);
      const model = await this.#pickModel(access, ctl.signal);
      if (!model.ok) return ctl.signal.aborted ? aborted() : reply(model.code);
      const { request } = buildAiRequest(task, model.slug, AI_OUTPUT_CAP);
      const out = await streamResponse(this.#d.http, {
        token: access.token,
        model: model.slug,
        request,
        signal: ctl.signal,
        timing: { ...this.#limits.stream, totalMs: Math.max(1, Math.min(this.#limits.stream.totalMs, deadlineAt - this.#d.now())) },
      });
      if (out.ok) return { ok: true, text: out.text, model: model.slug };
      return await this.#failureReply(out.failure, access, out.requestId, ctl.signal, aborted);
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(ctl);
    }
  }

  async #failureReply(f: ResponsesFailure, access: { rev: Rev; generation: number }, requestId: string | null, signal: AbortSignal, aborted: () => AiReply): Promise<AiReply> {
    switch (f.kind) {
      case 'aborted':
      case 'timeout':
        return f.kind === 'aborted' ? aborted() : reply('chatgpt-timeout', requestId);
      case 'usage-limit':
      case 'not-eligible':
        this.#setPause(access.generation, f.kind);
        return reply(FAILURE_CODE[f.kind], requestId);
      case 'auth': {
        const again = await this.#access({ signal, staleRev: access.rev });
        if (again.ok) return reply('chatgpt-auth-retry', requestId);
        if (again.reason === 'aborted') return aborted();
        return again.reason === 'retry' ? reply('chatgpt-auth-retry', requestId) : this.#accessReply(again.reason, requestId);
      }
      default:
        return reply(FAILURE_CODE[f.kind], requestId);
    }
  }

  #accessReply(reason: 'signin-required' | 'unavailable' | 'retry', requestId: string | null = null): AiReply {
    if (reason === 'signin-required') return reply('chatgpt-signin-required', requestId);
    return reply(reason === 'retry' ? 'chatgpt-auth-retry' : 'chatgpt-unavailable', requestId);
  }

  // ---- credentials ------------------------------------------------------------------------------------------------------

  /**
   * A usable access token. `staleRev` is the token set a 401 came back for: refresh only while it is still the stored
   * one, otherwise a newer set is already in place and must not be spent or cleared.
   */
  async #access(o: { signal: AbortSignal; staleRev?: Rev }): Promise<AccessResult> {
    const key = await this.#key();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = this.#credsRow();
      if (!row) return { ok: false, reason: 'signin-required' };
      if (o.staleRev !== undefined && row.rev !== o.staleRev) return { ok: false, reason: 'retry' };
      const parsed = CredentialsSchema.safeParse(readJson(await unseal(key, credsAad(row.rev), row.sealed)));
      const current = this.#credsRow();
      if (current?.rev !== row.rev) {
        if (o.staleRev !== undefined) return { ok: false, reason: 'retry' };
        continue;
      }
      if (!parsed.success) {
        this.#endSession(row, 'unreadable');
        return { ok: false, reason: 'signin-required' };
      }
      const creds = parsed.data;
      if (o.staleRev === undefined && refreshDecision(creds, this.#d.now()).kind === 'use') return { ok: true, token: creds.accessToken, rev: row.rev, generation: row.generation };
      let flight = this.#refreshing?.rev === row.rev ? this.#refreshing.promise : null;
      if (!flight) {
        const p: Promise<AccessResult> = this.#refresh(row, creds, key).finally(() => {
          if (this.#refreshing?.promise === p) this.#refreshing = null;
        });
        this.#refreshing = { rev: row.rev, promise: p };
        flight = p;
      }
      const r = await untilAborted(flight, o.signal);
      return r === 'aborted' ? { ok: false, reason: 'aborted' } : r;
    }
    return { ok: false, reason: 'unavailable' };
  }

  /** Shared by every waiter, so it has its own deadline (inside refreshGrant) and no caller can abort it mid-rotation. */
  async #refresh(row: CredsRow, creds: Credentials, key: CryptoKey): Promise<AccessResult> {
    const kv = this.#d.kv;
    const res = await refreshGrant(this.#d.http, { clientId: row.clientId, refreshToken: creds.refreshToken, now: this.#d.now(), signal: AbortSignal.timeout(this.#limits.refreshDeadlineMs) });
    if (!res.ok) {
      if (res.orphan) this.#revokeIfOrphan(row.clientId, res.orphan);
      if (res.failure.kind !== 'terminal' && res.failure.kind !== 'invalid-client') return { ok: false, reason: 'unavailable' };
      if (this.#credsRow()?.rev !== row.rev) return { ok: false, reason: 'retry' };
      if (res.failure.kind === 'invalid-client' && this.#registration()?.clientId === row.clientId) kv.del(K.registration);
      this.#endSession(row, res.failure.kind === 'invalid-client' ? 'invalid-client' : 'refresh-rejected');
      return { ok: false, reason: 'signin-required' };
    }
    const g = res.grant;
    const scopes = g.scopes ?? creds.scopes;
    if (!hasPlanScope(scopes)) {
      if (this.#credsRow()?.rev === row.rev) this.#endSession(row, 'refresh-rejected');
      this.#revokeIfOrphan(row.clientId, g.refreshToken);
      return { ok: false, reason: 'signin-required' };
    }
    const next: Credentials = { ...creds, accessToken: g.accessToken, refreshToken: g.refreshToken, expiresAt: g.expiresAt, earliestRefreshAt: g.earliestRefreshAt, scopes: [...scopes] };
    const rev = newRev();
    const sealed = await seal(key, credsAad(rev), JSON.stringify(next));
    if (this.#credsRow()?.rev !== row.rev) {
      this.#revokeIfOrphan(row.clientId, g.refreshToken);
      return { ok: false, reason: 'retry' };
    }
    kv.put(K.creds, JSON.stringify({ generation: row.generation, rev, clientId: row.clientId, sealed }));
    return { ok: true, token: g.accessToken, rev, generation: row.generation };
  }

  #endSession(row: CredsRow, reason: 'refresh-rejected' | 'invalid-client' | 'unreadable'): void {
    const kv = this.#d.kv;
    if (this.#credsRow()?.rev !== row.rev) return;
    kv.del(K.creds);
    kv.del(K.pause);
    kv.del(K.models);
    this.#bumpGeneration();
    this.#stopInflight('ended');
    this.#putNotice({ kind: 'session-ended', reason, at: this.#d.now() });
  }

  async #pickModel(access: Granted, signal: AbortSignal): Promise<{ ok: true; slug: ModelSlug } | { ok: false; code: ChatGptCode }> {
    let catalog = this.#cachedModels(access.generation);
    if (!catalog) {
      const r = await this.#fetchModels(access, signal);
      if (!r.ok) return r;
      catalog = r.models;
    }
    const wanted = this.#d.kv.get(K.model);
    const slug = parseModelSlug((catalog.find((m) => m.slug === wanted) ?? catalog[0])?.slug);
    return slug ? { ok: true, slug } : { ok: false, code: 'chatgpt-no-model' };
  }

  async #catalog(signal: AbortSignal): Promise<{ ok: true; models: ChatGptModel[] } | { ok: false; code: ChatGptCode }> {
    const access = await this.#access({ signal });
    if (!access.ok) return { ok: false, code: access.reason === 'signin-required' ? 'chatgpt-signin-required' : access.reason === 'aborted' ? 'chatgpt-timeout' : 'chatgpt-unavailable' };
    return this.#fetchModels(access, signal);
  }

  async #fetchModels(access: Granted, signal: AbortSignal): Promise<{ ok: true; models: ChatGptModel[] } | { ok: false; code: ChatGptCode }> {
    const r = await listModels(this.#d.http, { token: access.token, signal });
    if (!r.ok && r.failure.kind === 'auth') {
      const again = await this.#access({ signal, staleRev: access.rev });
      if (again.ok || again.reason === 'retry') return { ok: false, code: 'chatgpt-auth-retry' };
      return { ok: false, code: again.reason === 'signin-required' ? 'chatgpt-signin-required' : again.reason === 'aborted' ? 'chatgpt-timeout' : 'chatgpt-unavailable' };
    }
    if (!r.ok) return { ok: false, code: FAILURE_CODE[r.failure.kind] };
    const models = r.models.map((m) => ({ slug: m.slug, displayName: m.displayName }));
    if (this.#credsRow()?.generation === access.generation) this.#d.kv.put(K.models, JSON.stringify({ generation: access.generation, models }));
    return { ok: true, models };
  }

  // ---- revocation -------------------------------------------------------------------------------------------------------

  /**
   * Revokes only when no live session of the same client remains. OpenAI documents revocation on sign-out; whether revoking
   * one refresh token also ends sibling grants of the same client is not documented, so a token replaced within one client is
   * dropped from memory instead (never stored, logged or returned) and expires on its own. docs/CHATGPT.md lists the manual check.
   */
  #revokeIfOrphan(clientId: IssuedClientId, token: RefreshToken): void {
    void this.#revoke(clientId, token);
  }

  async #revokeRow(row: CredsRow): Promise<boolean> {
    const parsed = CredentialsSchema.safeParse(readJson(await unseal(await this.#key(), credsAad(row.rev), row.sealed)));
    if (!parsed.success) return false;
    if (this.#credsRow()?.clientId === row.clientId) return false;
    return this.#revoke(row.clientId, parsed.data.refreshToken);
  }

  /** Bounded as a whole, so a disconnect answers well before the browser's 30 s action timeout. */
  async #revoke(clientId: IssuedClientId, token: RefreshToken): Promise<boolean> {
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const signal = AbortSignal.timeout(this.#limits.revokeTotalMs);
    for (const delay of this.#limits.revokeDelaysMs) {
      if (delay > 0) await sleep(delay);
      if (signal.aborted || this.#credsRow()?.clientId === clientId) return false;
      const r = await revokeRefreshToken(this.#d.http, this.#directory, { clientId, refreshToken: token, signal });
      if (r === 'revoked') return true;
      if (r === 'rejected') return false;
    }
    return false;
  }

  // ---- rows -------------------------------------------------------------------------------------------------------------

  #loopbackReady(): boolean {
    return this.#d.loopback !== null && this.#sealBytes !== null;
  }

  #key(): Promise<CryptoKey> {
    const bytes = this.#sealBytes;
    if (!bytes) return Promise.reject(new Error('ChatGPT seal key is not configured'));
    this.#sealKey ??= crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return this.#sealKey;
  }

  #stopInflight(cut: Cut): void {
    for (const stop of this.#inflight.values()) stop(cut);
  }

  #hostId(): HostId {
    const existing = parseHostId(this.#d.kv.get(K.host));
    if (existing) return existing;
    const id = newHostId();
    this.#d.kv.put(K.host, id);
    return id;
  }

  #registration(): Registration | null {
    const r = RegistrationSchema.safeParse(readJson(this.#d.kv.get(K.registration)));
    return r.success ? r.data : null;
  }

  #credsRow(): CredsRow | null {
    const r = CredsRowSchema.safeParse(readJson(this.#d.kv.get(K.creds)));
    return r.success ? r.data : null;
  }

  #pending(): PendingRow | null {
    const r = PendingRowSchema.safeParse(readJson(this.#d.kv.get(K.pending)));
    return r.success ? r.data : null;
  }

  #notice(): ChatGptNotice | null {
    const r = NoticeSchema.safeParse(readJson(this.#d.kv.get(K.notice)));
    if (!r.success) return null;
    const n = r.data;
    if (n.kind !== 'sign-in') return n;
    const outcome = SIGN_IN_OUTCOME_SET.get(n.outcome);
    return outcome ? { kind: 'sign-in', outcome, at: n.at } : null;
  }

  #putNotice(n: ChatGptNotice): void {
    this.#d.kv.put(K.notice, JSON.stringify(n));
  }

  #pause(generation: number): { code: ChatGptPauseCode; since: number } | null {
    const r = PauseSchema.safeParse(readJson(this.#d.kv.get(K.pause)));
    return r.success && r.data.generation === generation ? r.data : null;
  }

  #setPause(generation: number, code: ChatGptPauseCode): void {
    if (this.#credsRow()?.generation === generation) this.#d.kv.put(K.pause, JSON.stringify({ generation, code, since: this.#d.now() }));
  }

  #cachedModels(generation: number): ChatGptModel[] | null {
    const r = ModelsRowSchema.safeParse(readJson(this.#d.kv.get(K.models)));
    return r.success && r.data.generation === generation ? r.data.models : null;
  }

  /** The user's choice while it is still in this account's catalog. No catalog yet means no model is shown or used. */
  #selectedModel(generation: number): ChatGptModel | null {
    const slug = this.#d.kv.get(K.model);
    const catalog = this.#cachedModels(generation);
    if (!catalog) return null;
    return catalog.find((m) => m.slug === slug) ?? null;
  }

  #bumpGeneration(): number {
    const next = Number(this.#d.kv.get(K.generation) ?? '0') + 1;
    this.#d.kv.put(K.generation, String(next));
    return next;
  }

  #bumpOp(): string {
    const next = String(Number(this.#d.kv.get(K.op) ?? '0') + 1);
    this.#d.kv.put(K.op, next);
    return next;
  }
}

const SIGN_IN_OUTCOME_SET: ReadonlyMap<string, SignInOutcome> = new Map(SIGN_IN_OUTCOMES.map((o) => [o, o]));
