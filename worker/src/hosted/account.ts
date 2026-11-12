import { z } from 'zod';
import { newPairingId, newPairingKeys, openConnection, parseSealedConnection, type PairingId, type PairingRequest, type SealedConnection } from '../../../src/core/chatgpt/bridge';
import { CHATGPT_REPLY, FAILURE_CODE, GATE_REASON, PAUSE_SENTENCE, type ChatGptCode, type StartRefusal } from '../../../src/core/chatgpt/messages';
import {
  callbackClientId,
  hasPlanScope,
  newHostId,
  OpenAiDirectory,
  refreshDecision,
  refreshGrant,
  revokeRefreshToken,
  type AccessToken,
  type ClientMode,
  type HostId,
  type IssuedClientId,
  type OutboundFetch,
  type RefreshToken,
} from '../../../src/core/chatgpt/oauth';
import { DEFAULT_STREAM_TIMING, listModels, parseModelSlug, streamResponse, type ModelSlug, type ResponsesFailure, type StreamTiming } from '../../../src/core/chatgpt/responses';
import { AI_OUTPUT_CAP, type AiReply, type AiStatus, type AiTask, type ChatGptConnection, type ChatGptModel, type ChatGptNotice, type ChatGptPauseCode, type SignInOutcome } from '../../../src/core/tutor/contract';
import { buildAiRequest } from '../../../src/core/tutor/prompts';
import { CredentialsSchema, decideSignIn, reply, untilAborted, type AiGate, type Credentials, type DisconnectReply, type ModelsReply, type SelectReply, type StartOptions } from '../chatgpt';
import { toBase64Url } from '../encoding';
import { credsAad, parseSealKeyBytes, seal, unseal } from '../seal';
import type { SiteUserId } from '../sites/boundary';
import { HostedStore, newLeaseId, newRev, type AccountRow, type D1Like, type LeaseId, type Pairing, type Rev, type SessionEndReason, type StoredCreds } from './store';

/**
 * The ChatGPT account of one owner-private Site, over one D1 row shared by every isolate. Same contract as the local
 * `ChatGptAccount`, but sign-in arrives as an encrypted connection file (src/core/chatgpt/bridge.ts) instead of a loopback
 * callback, and every cross-await write is a guarded statement in ./store.ts.
 *
 * Rotation never resends: a lease grants one send of a rev's refresh token, and that send ends only in a commit (new rev),
 * a definite "not spent" release, a session end, or `indeterminate`, which blocks every further send and keeps the current
 * access token in use until it expires. Its concurrency cap and stream cancellation apply only to calls sharing this account instance.
 */

/** The fixed answer for a Sites user who is not this Site's owner. It names nobody. */
export const HOSTED_ACCESS_MESSAGE = '이 StudyAI의 ChatGPT 연결은 사이트 소유자만 사용할 수 있습니다.';
export class HostedAccessError extends Error {
  readonly status = 403;
  constructor() {
    super(HOSTED_ACCESS_MESSAGE);
    this.name = 'HostedAccessError';
  }
}

export interface HostedLimits {
  /** The whole ask, from before the token check to the last stream byte. Below the browser's 180 s. */
  askDeadlineMs: number;
  /** Per account instance. The Sites route separately caps requests within an isolate. */
  maxConcurrent: number;
  pairingTtlMs: number;
  /** ID-token keys at install, and one model-list call. */
  verifyDeadlineMs: number;
  /** One refresh send. Its own deadline: no ask may cancel it after upstream may have rotated. */
  refreshDeadlineMs: number;
  /** How long a silent holder blocks other refreshes. Commits carry no time check, so this bounds waiting only. */
  leaseMs: number;
  /** A waiter whose access token has this much left uses it instead of waiting. */
  minRemainingMs: number;
  waitReads: number;
  waitIntervalMs: number;
  commitDelaysMs: readonly number[];
  stream: StreamTiming;
  revokeDelaysMs: readonly number[];
  revokeTotalMs: number;
}

const DEFAULT_LIMITS: HostedLimits = {
  askDeadlineMs: 170_000,
  maxConcurrent: 2,
  pairingTtlMs: 10 * 60_000,
  verifyDeadlineMs: 30_000,
  refreshDeadlineMs: 15_000,
  leaseMs: 60_000,
  minRemainingMs: 5_000,
  waitReads: 20,
  waitIntervalMs: 500,
  commitDelaysMs: [0, 250, 1_000],
  stream: DEFAULT_STREAM_TIMING,
  revokeDelaysMs: [0, 500, 1_500],
  revokeTotalMs: 20_000,
};

export interface HostedDeps {
  db: D1Like;
  /** Raw CHATGPT_SEAL_KEY: base64url of 32 random bytes. Anything else turns ChatGPT off on this Site. */
  sealKey: string | undefined;
  http: OutboundFetch;
  now: () => number;
  /** `ctx.waitUntil`. Chains that would strand a token if cut are registered here and also awaited. */
  defer: (promise: Promise<unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<HostedLimits>;
}

export type PairingReply = { ok: true; request: PairingRequest } | { ok: false; error: StartRefusal };

const pairingAad = (id: PairingId) => `studyai/chatgpt/pairing/v1/${id}`;
const PairingSecretSchema = z.object({ privateJwk: z.looseObject({ kty: z.string() }), nonce: z.string().min(1) });

type Granted = { token: AccessToken; rev: Rev; generation: number };
type AccessResult = ({ ok: true } & Granted) | { ok: false; reason: 'signin-required' | 'unavailable' | 'retry' | 'aborted' };
type Cut = 'deadline' | 'replaced' | 'ended';
type Commit = 'applied' | 'lost' | 'unknown';

const ended = (reason: SessionEndReason, at: number): ChatGptNotice => ({ kind: 'session-ended', reason, at });
const noop = (): void => {};

export class HostedChatGptAccount {
  readonly #d: HostedDeps;
  readonly #limits: HostedLimits;
  readonly #directory: OpenAiDirectory;
  readonly #sealBytes: Uint8Array<ArrayBuffer> | null;
  #sealKey: Promise<CryptoKey> | null = null;
  /** Calls sharing this instance share one refresh. D1 serializes refreshes across instances. */
  #refreshing: { rev: Rev; promise: Promise<AccessResult | 'waiter'> } | null = null;
  readonly #inflight = new Map<AbortController, (cut: Cut) => void>();

  constructor(deps: HostedDeps) {
    this.#d = deps;
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.#directory = new OpenAiDirectory({ http: deps.http, now: deps.now });
    this.#sealBytes = parseSealKeyBytes(deps.sealKey);
  }


  async status(user: SiteUserId): Promise<AiStatus> {
    const row = await this.#open().read();
    this.#authorize(row, user);
    let connection: ChatGptConnection;
    const reg = row?.registration ?? null;
    if (row?.creds) connection = { kind: 'connected', email: reg?.email ?? null, model: selectedModel(row), pause: row.pause };
    else if (reg?.planDisabled) connection = { kind: 'plan-disabled', email: reg.email };
    else connection = { kind: 'disconnected', registered: reg !== null, email: reg?.email ?? null };
    const p = row?.pairing;
    return {
      ...this.#gate(row),
      signInAvailable: this.#sealBytes !== null,
      connectVia: 'file',
      connection,
      pendingUntil: p && row.intent === p.id && p.userId === user && p.expiresAt > this.#d.now() ? p.expiresAt : null,
      notice: row?.notice ?? null,
    };
  }

  #gate(row: AccountRow | null): AiGate {
    if (!this.#sealBytes) return { state: 'off', reasons: [GATE_REASON['not-configured']] };
    if (row?.creds) return row.pause ? { state: 'paused', reasons: [PAUSE_SENTENCE[row.pause.code]] } : { state: 'ready', reasons: [] };
    if (row?.registration?.planDisabled) return { state: 'off', reasons: [GATE_REASON['plan-disabled']] };
    return { state: 'off', reasons: [row?.notice?.kind === 'session-ended' ? GATE_REASON.ended : GATE_REASON.disconnected] };
  }


  /** The newest start wins: `intent` is stamped before any await, and the pairing is stored only while it is still ours. */
  async createPairing(user: SiteUserId, o: StartOptions): Promise<PairingReply> {
    if (!this.#sealBytes) return { ok: false, error: 'not-configured' };
    const store = this.#open();
    let row = await store.read();
    if (!row) {
      await store.ensureRow(newHostId());
      row = await store.read();
    }
    this.#authorize(row, user);
    const intent = newPairingId();
    if (!(await store.beginPairing({ intent, user }))) throw new HostedAccessError();
    row = await store.read();
    if (!row || row.intent !== intent) return { ok: false, error: 'superseded' };
    const reg = row.registration;
    const client: ClientMode = o.account === 'other' || !reg ? { kind: 'dynamic' } : { kind: 'issued', clientId: reg.clientId, loginHint: reg.email };
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const [keys, key] = await Promise.all([newPairingKeys(), this.#key()]);
    const sealed = await seal(key, pairingAad(intent), JSON.stringify({ privateJwk: keys.privateJwk, nonce }));
    const createdAt = this.#d.now();
    const expiresAt = createdAt + this.#limits.pairingTtlMs;
    const stored = await store.storePairing({ id: intent, userId: user, createdAt, expiresAt, purpose: client.kind === 'dynamic' ? 'new' : 'reauth', clientId: client.kind === 'issued' ? client.clientId : null, sealed });
    if (!stored) return { ok: false, error: 'superseded' };
    return { ok: true, request: { v: 'studyai-pairing/1', pairingId: intent, hostId: row.hostId, nonce, client, forceConsent: o.forceConsent, publicKey: keys.publicJwk, expiresAt } };
  }

  /**
   * One uploaded connection file. Anything that is not a sealed connection (the request file picked by mistake) is refused
   * before the pairing is touched. After the single-use consume, the rest runs as one deferred-and-awaited chain.
   */
  async install(user: SiteUserId, raw: unknown): Promise<{ outcome: SignInOutcome }> {
    const store = this.#open();
    const row = await store.read();
    this.#authorize(row, user);
    const file = parseSealedConnection(raw);
    if (!file) return { outcome: 'file-invalid' };
    if (!this.#sealBytes) return { outcome: 'unknown-attempt' };
    const p = row?.pairing;
    if (!row || !p || p.id !== file.pairingId || p.userId !== user || row.intent !== p.id) return { outcome: 'unknown-attempt' };
    const now = this.#d.now();
    if (now >= p.expiresAt) {
      await store.settlePairing({ intent: p.id, notice: { kind: 'sign-in', outcome: 'expired', at: now } });
      return { outcome: 'expired' };
    }
    const hostId = row.hostId;
    const chain = async (): Promise<SignInOutcome> =>
      (await store.consumePairing({ pairingId: p.id, user, sealed: p.sealed, now })) ? this.#completeInstall(store, user, hostId, p, file) : 'unknown-attempt';
    return { outcome: await this.#critical(chain()) };
  }

  async #completeInstall(store: HostedStore, user: SiteUserId, hostId: HostId, p: Pairing, file: SealedConnection): Promise<SignInOutcome> {
    const settle = async (outcome: SignInOutcome): Promise<SignInOutcome> =>
      (await store.settlePairing({ intent: p.id, notice: { kind: 'sign-in', outcome, at: this.#d.now() } })) ? outcome : 'superseded';
    const key = await this.#key();
    const secret = PairingSecretSchema.safeParse(readJson(await unseal(key, pairingAad(p.id), p.sealed)));
    if (!secret.success) return settle('unknown-attempt');
    const payload = await openConnection({ pairingId: p.id, hostId }, secret.data.privateJwk, file);
    if (!payload) return settle('file-invalid');

    const mode: ClientMode = p.purpose === 'reauth' && p.clientId ? { kind: 'issued', clientId: p.clientId, loginHint: null } : { kind: 'dynamic' };
    const clientId = callbackClientId(mode, payload.clientId);
    const orphan = async (outcome: SignInOutcome, owner: IssuedClientId = clientId ?? payload.clientId): Promise<SignInOutcome> => {
      const settled = await settle(outcome);
      await this.#revokeIfOrphan(store, owner, payload.refreshToken);
      return settled;
    };
    if (!clientId) return orphan(mode.kind === 'dynamic' ? 'registration-incomplete' : 'client-mismatch', payload.clientId);
    const verified = await this.#directory.verifyTransferredIdToken(
      payload.idToken,
      { clientId, nonce: secret.data.nonce, issuedWithin: [p.createdAt - 60_000, p.expiresAt] },
      AbortSignal.timeout(this.#limits.verifyDeadlineMs),
    );
    if (!verified.ok) return orphan(verified.problem === 'keys-unavailable' ? 'upstream-unavailable' : 'id-token-invalid');
    if (!hasPlanScope(payload.scopes)) return orphan('plan-not-enabled');

    const identity = verified.identity;
    const now = this.#d.now();
    const lifetimeMs = payload.expiresInS * 1000;
    const creds: Credentials = {
      subject: identity.subject,
      email: identity.email,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: Math.min(identity.issuedAt + lifetimeMs, now + lifetimeMs),
      earliestRefreshAt: payload.earliestRefreshAt,
      scopes: [...payload.scopes],
    };
    const next: StoredCreds = { rev: newRev(), clientId, sealed: '' };
    next.sealed = await seal(key, credsAad(next.rev), JSON.stringify(creds));
    const notice: ChatGptNotice = { kind: 'sign-in', outcome: 'connected', at: now };
    /** The set an attempt would replace with another client's, kept across a thrown attempt that may have applied. */
    let replaced: StoredCreds | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let cur: AccountRow | null;
      try {
        cur = await store.read();
      } catch {
        continue;
      }
      if (cur?.creds?.rev === next.rev) return this.#installed(store, replaced);
      if (cur?.ownerUserId != null && cur.ownerUserId !== user) {
        await this.#revokeIfOrphan(store, clientId, payload.refreshToken);
        throw new HostedAccessError();
      }
      if (!cur || cur.intent !== p.id) {
        await this.#revokeIfOrphan(store, clientId, payload.refreshToken);
        return 'superseded';
      }
      const old = cur.creds;
      const decision = decideSignIn({ purpose: p.purpose, registration: cur.registration, liveClientId: old?.clientId ?? null, attemptClientId: clientId, result: { kind: 'granted', identity } });
      if (!decision.install || decision.registration === 'keep') return orphan(decision.outcome);
      replaced = decision.revokeOld ? old : null;
      try {
        if (await store.install({ intent: p.id, user, expectRev: old?.rev ?? null, next, registration: decision.registration, notice })) return this.#installed(store, replaced);
      } catch {
        // The write may have applied; the next read decides.
      }
    }
    const last = await store.read().catch(() => null);
    if (last?.creds?.rev === next.rev) return this.#installed(store, replaced);
    if (last) await this.#revokeIfOrphan(store, clientId, payload.refreshToken);
    return 'upstream-unavailable';
  }

  async #installed(store: HostedStore, replaced: StoredCreds | null): Promise<SignInOutcome> {
    this.#stopInflight('replaced');
    if (replaced) await this.#revokeStored(store, replaced);
    return 'connected';
  }

  /** Clears exactly the set it read, retrying when a refresh committed first, then revokes that set. The owner stays. */
  disconnect(user: SiteUserId, o: { forget: boolean }): Promise<DisconnectReply> {
    return this.#critical(this.#disconnect(this.#open(), user, o));
  }

  async #disconnect(store: HostedStore, user: SiteUserId, o: { forget: boolean }): Promise<DisconnectReply> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await store.read();
      this.#authorize(row, user);
      if (!row) return { ok: true, remoteRevoked: true };
      const cleared = row.creds;
      const op = await store.disconnect({ expectRev: cleared?.rev ?? null, forget: o.forget, notice: cleared ? { kind: 'disconnected', remoteRevoked: null, at: this.#d.now() } : null });
      if (op === null) continue;
      this.#stopInflight('replaced');
      if (!cleared) return { ok: true, remoteRevoked: true };
      const remoteRevoked = await this.#revokeStored(store, cleared);
      await store.putNotice({ op, notice: { kind: 'disconnected', remoteRevoked, at: this.#d.now() } });
      return { ok: true, remoteRevoked };
    }
    throw new Error('disconnect lost three races to token refreshes');
  }


  async models(user: SiteUserId): Promise<ModelsReply> {
    const store = this.#open();
    this.#authorize(await store.read(), user);
    const signal = AbortSignal.timeout(this.#limits.verifyDeadlineMs);
    const access = await this.#access(store, { signal });
    if (!access.ok) {
      const code = accessCode(access.reason);
      return { ok: false, code, message: CHATGPT_REPLY[code].message };
    }
    const r = await this.#fetchModels(store, access, signal);
    if (!r.ok) return { ok: false, code: r.code, message: CHATGPT_REPLY[r.code].message };
    const row = await store.read();
    return { ok: true, models: r.models, selected: row ? (selectedModel(row)?.slug ?? null) : null };
  }

  async selectModel(user: SiteUserId, raw: unknown): Promise<SelectReply> {
    const store = this.#open();
    const row = await store.read();
    this.#authorize(row, user);
    const slug = parseModelSlug(raw);
    if (!slug || !row?.creds) return { ok: false, error: 'ChatGPT가 연결되어 있지 않습니다.' };
    if (!cachedModels(row)?.some((m) => m.slug === slug)) return { ok: false, error: '이 계정의 모델 목록에 없는 모델입니다. 목록을 새로 고친 뒤 다시 고르세요.' };
    if (!(await store.selectModel({ generation: row.generation, slug }))) return { ok: false, error: 'ChatGPT가 연결되어 있지 않습니다.' };
    return { ok: true };
  }

  async resume(user: SiteUserId): Promise<void> {
    const store = this.#open();
    const row = await store.read();
    this.#authorize(row, user);
    if (row) await store.clearPause({ generation: row.generation });
  }

  /** One AI task on the plan. Never resends a request on its own. */
  async ask(user: SiteUserId, task: AiTask): Promise<AiReply> {
    const store = this.#open();
    const row = await store.read();
    this.#authorize(row, user);
    const gate = this.#gate(row);
    if (gate.state !== 'ready' || !row) {
      if (gate.state === 'paused') return reply('chatgpt-paused');
      if (!this.#sealBytes) return reply('chatgpt-not-configured');
      return reply(row?.registration?.planDisabled ? 'chatgpt-plan-disabled' : 'chatgpt-signin-required');
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
      const access = await this.#access(store, { signal: ctl.signal });
      if (!access.ok) return access.reason === 'aborted' || ctl.signal.aborted ? aborted() : accessReply(access.reason);
      const model = await this.#pickModel(store, row, access, ctl.signal);
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
      return await this.#failureReply(store, out.failure, access, out.requestId, ctl.signal, aborted);
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(ctl);
    }
  }

  async #failureReply(store: HostedStore, f: ResponsesFailure, access: Granted, requestId: string | null, signal: AbortSignal, aborted: () => AiReply): Promise<AiReply> {
    switch (f.kind) {
      case 'aborted':
      case 'timeout':
        return f.kind === 'aborted' ? aborted() : reply('chatgpt-timeout', requestId);
      case 'usage-limit':
      case 'not-eligible':
        await this.#setPause(store, access.generation, f.kind);
        return reply(FAILURE_CODE[f.kind], requestId);
      case 'auth': {
        const again = await this.#access(store, { signal, staleRev: access.rev });
        if (again.ok || again.reason === 'retry') return reply('chatgpt-auth-retry', requestId);
        return again.reason === 'aborted' ? aborted() : accessReply(again.reason, requestId);
      }
      default:
        return reply(FAILURE_CODE[f.kind], requestId);
    }
  }


  /**
   * A usable access token. `staleRev` is the set a 401 came back for: refresh only while it is still stored, and never fall
   * back to its access token, which upstream just refused.
   */
  async #access(store: HostedStore, o: { signal: AbortSignal; staleRev?: Rev }): Promise<AccessResult> {
    const key = await this.#key();
    const forced = o.staleRev !== undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await store.read();
      const stored = row?.creds;
      if (!row || !stored) return { ok: false, reason: 'signin-required' };
      if (forced && stored.rev !== o.staleRev) return { ok: false, reason: 'retry' };
      const parsed = CredentialsSchema.safeParse(readJson(await unseal(key, credsAad(stored.rev), stored.sealed)));
      if (!parsed.success) {
        if (await store.endUnreadableSession({ rev: stored.rev, notice: ended('unreadable', this.#d.now()) })) return this.#ended();
        continue;
      }
      const creds = parsed.data;
      const current: AccessResult = { ok: true, token: creds.accessToken, rev: stored.rev, generation: row.generation };
      const usable = (marginMs: number) => !forced && creds.expiresAt - this.#d.now() > marginMs;
      if (!forced && refreshDecision(creds, this.#d.now()).kind === 'use') return current;
      if (row.refreshState === 'indeterminate') {
        if (usable(0)) return current;
        if (await store.endIndeterminateSession({ rev: stored.rev, notice: ended('refresh-indeterminate', this.#d.now()) })) return this.#ended();
        continue;
      }
      let flight = this.#refreshing?.rev === stored.rev ? this.#refreshing.promise : null;
      if (!flight) {
        const p: Promise<AccessResult | 'waiter'> = this.#claimAndRefresh(store, row.generation, stored, creds, key).finally(() => {
          if (this.#refreshing?.promise === p) this.#refreshing = null;
        });
        this.#refreshing = { rev: stored.rev, promise: p };
        flight = p;
      }
      const r = await untilAborted(flight, o.signal);
      if (r === 'aborted') return { ok: false, reason: 'aborted' };
      if (r !== 'waiter') return !r.ok && r.reason === 'unavailable' && usable(0) ? current : r;
      if (usable(this.#limits.minRemainingMs)) return current;
      const waited = await this.#wait(store, stored.rev, o.signal);
      if (waited !== 'changed') return waited;
    }
    return { ok: false, reason: 'unavailable' };
  }

  /** Deferred from the claim on: a request cut right after claiming must still send, record the outcome and release. */
  #claimAndRefresh(store: HostedStore, generation: number, stored: StoredCreds, creds: Credentials, key: CryptoKey): Promise<AccessResult | 'waiter'> {
    const chain = async (): Promise<AccessResult | 'waiter'> => {
      const leaseId = newLeaseId();
      if (!(await store.claimRefresh({ rev: stored.rev, leaseId, until: this.#d.now() + this.#limits.leaseMs }))) return 'waiter';
      return this.#holdRefresh(store, generation, stored, creds, key, leaseId);
    };
    return this.#critical(chain());
  }

  /** The one send for this rev. Every exit records what became of it. */
  async #holdRefresh(store: HostedStore, generation: number, stored: StoredCreds, creds: Credentials, key: CryptoKey, leaseId: LeaseId): Promise<AccessResult> {
    const held = { rev: stored.rev, leaseId };
    const res = await refreshGrant(this.#d.http, { clientId: stored.clientId, refreshToken: creds.refreshToken, now: this.#d.now(), signal: AbortSignal.timeout(this.#limits.refreshDeadlineMs) });
    if (!res.ok) {
      const f = res.failure;
      switch (f.kind) {
        case 'rejected':
          await store.releaseRefresh(held);
          return { ok: false, reason: 'unavailable' };
        case 'transient':
          if (f.spent === 'no') await store.releaseRefresh(held);
          else await store.markIndeterminate(held);
          return { ok: false, reason: 'unavailable' };
        case 'terminal':
        case 'invalid-client':
        case 'invalid-response': {
          const reason = f.kind === 'invalid-client' ? 'invalid-client' : 'refresh-rejected';
          const done = await store.endSessionByRefresh({ ...held, dropRegistration: f.kind === 'invalid-client', notice: ended(reason, this.#d.now()) });
          if (res.orphan) await this.#revokeIfOrphan(store, stored.clientId, res.orphan);
          return done ? this.#ended() : { ok: false, reason: 'retry' };
        }
        default: {
          const exhaustive: never = f;
          return exhaustive;
        }
      }
    }
    const g = res.grant;
    const scopes = g.scopes ?? creds.scopes;
    if (!hasPlanScope(scopes)) {
      const done = await store.endSessionByRefresh({ ...held, dropRegistration: false, notice: ended('refresh-rejected', this.#d.now()) });
      await this.#revokeIfOrphan(store, stored.clientId, g.refreshToken);
      return done ? this.#ended() : { ok: false, reason: 'retry' };
    }
    const nextCreds: Credentials = { ...creds, accessToken: g.accessToken, refreshToken: g.refreshToken, expiresAt: g.expiresAt, earliestRefreshAt: g.earliestRefreshAt, scopes: [...scopes] };
    const next = { rev: newRev(), sealed: '' };
    next.sealed = await seal(key, credsAad(next.rev), JSON.stringify(nextCreds));
    const committed = await this.#commit(store, held, next);
    if (committed === 'applied') return { ok: true, token: g.accessToken, rev: next.rev, generation };
    if (committed === 'lost') await this.#revokeIfOrphan(store, stored.clientId, g.refreshToken);
    return { ok: false, reason: committed === 'lost' ? 'retry' : 'unavailable' };
  }

  /**
   * A thrown write may still have applied, so a throw is resolved by reading: our own rev means applied. Without any read
   * that settles it, the result is 'unknown' and nothing is revoked; the lease then blocks resends until a waiter abandons it.
   */
  async #commit(store: HostedStore, held: { rev: Rev; leaseId: LeaseId }, next: { rev: Rev; sealed: string }): Promise<Commit> {
    let threw = false;
    for (const delay of this.#limits.commitDelaysMs) {
      if (delay > 0) await this.#sleep(delay);
      try {
        if (await store.commitRefresh({ ...held, next })) return 'applied';
        if (!threw) return 'lost';
      } catch {
        threw = true;
      }
      try {
        const row = await store.read();
        if (row?.creds?.rev === next.rev) return 'applied';
        if (row?.creds?.rev !== held.rev || row.lease?.id !== held.leaseId) return 'lost';
      } catch {
      }
    }
    return 'unknown';
  }

  /** Never sends. Waits for the holder's outcome, and marks a holder that outlived its lease as indeterminate. */
  async #wait(store: HostedStore, rev: Rev, signal: AbortSignal): Promise<AccessResult | 'changed'> {
    for (let i = 0; i < this.#limits.waitReads; i += 1) {
      await this.#sleep(this.#limits.waitIntervalMs);
      if (signal.aborted) return { ok: false, reason: 'aborted' };
      const row = await store.read();
      if (!row?.creds || row.creds.rev !== rev || row.refreshState !== 'ok' || !row.lease) return 'changed';
      if (row.lease.until < this.#d.now()) {
        await store.abandonStaleLease({ rev, leaseId: row.lease.id, now: this.#d.now() });
        return { ok: false, reason: 'retry' };
      }
    }
    return { ok: false, reason: 'retry' };
  }

  #ended(): AccessResult {
    this.#stopInflight('ended');
    return { ok: false, reason: 'signin-required' };
  }

  async #pickModel(store: HostedStore, row: AccountRow, access: Granted, signal: AbortSignal): Promise<{ ok: true; slug: ModelSlug } | { ok: false; code: ChatGptCode }> {
    let catalog = row.generation === access.generation ? cachedModels(row) : null;
    if (!catalog) {
      const r = await this.#fetchModels(store, access, signal);
      if (!r.ok) return r;
      catalog = r.models;
    }
    const slug = parseModelSlug((catalog.find((m) => m.slug === row.model) ?? catalog[0])?.slug);
    return slug ? { ok: true, slug } : { ok: false, code: 'chatgpt-no-model' };
  }

  async #fetchModels(store: HostedStore, access: Granted, signal: AbortSignal): Promise<{ ok: true; models: ChatGptModel[] } | { ok: false; code: ChatGptCode }> {
    const r = await listModels(this.#d.http, { token: access.token, signal });
    if (!r.ok && r.failure.kind === 'auth') {
      const again = await this.#access(store, { signal, staleRev: access.rev });
      if (again.ok || again.reason === 'retry') return { ok: false, code: 'chatgpt-auth-retry' };
      return { ok: false, code: accessCode(again.reason) };
    }
    if (!r.ok) return { ok: false, code: FAILURE_CODE[r.failure.kind] };
    const models = r.models.map((m) => ({ slug: m.slug, displayName: m.displayName }));
    await store.cacheModels({ generation: access.generation, models });
    return { ok: true, models };
  }

  async #setPause(store: HostedStore, generation: number, code: ChatGptPauseCode): Promise<void> {
    await store.setPause({ generation, pause: { code, since: this.#d.now() } });
  }


  async #revokeStored(store: HostedStore, stored: StoredCreds): Promise<boolean> {
    const parsed = CredentialsSchema.safeParse(readJson(await unseal(await this.#key(), credsAad(stored.rev), stored.sealed)));
    if (!parsed.success) return false;
    return this.#revokeIfOrphan(store, stored.clientId, parsed.data.refreshToken);
  }

  /**
   * Revokes only when no live session of the same client remains, re-read before each attempt. Whether revoking one refresh
   * token also ends sibling grants of that client is undocumented, so a token replaced within one client is dropped instead.
   * Always called inside a deferred chain (install, refresh or disconnect).
   */
  async #revokeIfOrphan(store: HostedStore, clientId: IssuedClientId, token: RefreshToken): Promise<boolean> {
    const signal = AbortSignal.timeout(this.#limits.revokeTotalMs);
    for (const delay of this.#limits.revokeDelaysMs) {
      if (delay > 0) await this.#sleep(delay);
      if (signal.aborted) return false;
      const row = await store.read();
      if (row?.creds?.clientId === clientId) return false;
      const r = await revokeRefreshToken(this.#d.http, this.#directory, { clientId, refreshToken: token, signal });
      if (r === 'revoked') return true;
      if (r === 'rejected') return false;
    }
    return false;
  }


  /** Owner binding is immutable once claimed, so a check after any read is enough for every non-claiming write. */
  #authorize(row: AccountRow | null, user: SiteUserId): void {
    if (row?.ownerUserId != null && row.ownerUserId !== user) throw new HostedAccessError();
  }

  #open(): HostedStore {
    return new HostedStore(this.#d.db);
  }

  /** Registered with the platform so a closed connection cannot cut it, and returned so the request awaits it too. */
  #critical<T>(p: Promise<T>): Promise<T> {
    this.#d.defer(p.then(noop, noop));
    return p;
  }

  #sleep(ms: number): Promise<void> {
    return (this.#d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
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
}

const readJson = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const cachedModels = (row: AccountRow): ChatGptModel[] | null => (row.models?.generation === row.generation ? row.models.list : null);
const selectedModel = (row: AccountRow): ChatGptModel | null => cachedModels(row)?.find((m) => m.slug === row.model) ?? null;

function accessCode(reason: 'signin-required' | 'unavailable' | 'retry' | 'aborted'): ChatGptCode {
  if (reason === 'signin-required') return 'chatgpt-signin-required';
  if (reason === 'aborted') return 'chatgpt-timeout';
  return reason === 'retry' ? 'chatgpt-auth-retry' : 'chatgpt-unavailable';
}

function accessReply(reason: 'signin-required' | 'unavailable' | 'retry', requestId: string | null = null): AiReply {
  return reply(accessCode(reason), requestId);
}
