import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sealConnection, type ConnectionPayload, type PairingRequest } from '../src/core/chatgpt/bridge';
import { authorizeUrl, callbackClientId, completeSignIn, loopbackRedirectUri, newHostId, OpenAiDirectory, parseCallbackQuery, type OutboundFetch } from '../src/core/chatgpt/oauth';
import type { AiReply, AiTask } from '../src/core/tutor/contract';
import type { StartOptions } from '../worker/src/chatgpt';
import { toBase64Url } from '../worker/src/encoding';
import { HOSTED_ACCESS_MESSAGE, HostedAccessError, HostedChatGptAccount, type HostedLimits } from '../worker/src/hosted/account';
import { HostedStore } from '../worker/src/hosted/store';
import type { SiteUserId } from '../worker/src/sites/boundary';
import { localD1, withFaults, type D1Faults } from './helpers/d1';
import { createFakeOpenAi } from './helpers/fake-openai.mjs';

const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const HOUR = 3_600_000;
const OWNER = 'site-user-7f3a' as SiteUserId;
const OTHER = 'site-user-c210' as SiteUserId;
const CURRENT: StartOptions = { account: 'current', forceConsent: false };
const OTHER_ACCOUNT: StartOptions = { account: 'other', forceConsent: false };
const TASK: AiTask = { task: 'tutor', mode: 'explain', question: '테이프가 뭔가요?', excerpts: [{ ref: 'S1', lectureTitle: 'L1', slide: 1, title: 'Tape', text: 'The tape is unbounded.' }], history: [] };
/** Deterministic and fast: no backoff between commit or revoke attempts, waiters poll without delay. */
const FAST: Partial<HostedLimits> = { waitIntervalMs: 0, commitDelaysMs: [0, 0, 0], revokeDelaysMs: [0, 0, 0] };

let d1: Awaited<ReturnType<typeof localD1>>;
beforeAll(async () => {
  d1 = await localD1();
});
afterAll(async () => d1.dispose());
beforeEach(async () => d1.reset());

type Rig = ReturnType<typeof rig>;
const rigs: { fake: { reused(): number }; expectReuse: boolean; settled(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.settled();
    if (!r.expectReuse) expect(r.fake.reused(), 'R8: no refresh token was sent after it rotated').toBe(0);
  }
});

function rig(limits: Partial<HostedLimits> = {}) {
  let clock = T0;
  const now = () => clock;
  const fake = createFakeOpenAi({ now });
  const sealKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const deferred: Promise<unknown>[] = [];
  const parked = new Map<string, { reached: () => void; gate: Promise<void> }>();
  /** The Site's outbound fetch. `park` stops the next request to a URL so a test can interleave another instance. */
  const http: OutboundFetch = async (url, init) => {
    for (const [fragment, p] of parked) {
      if (!url.includes(fragment)) continue;
      parked.delete(fragment);
      p.reached();
      await p.gate;
      break;
    }
    return fake.fetch(url, init);
  };
  const make = (o: { faults?: D1Faults; sealKey?: string; limits?: Partial<HostedLimits> } = {}) =>
    new HostedChatGptAccount({
      db: o.faults ? withFaults(d1.db, o.faults) : d1.db,
      sealKey: 'sealKey' in o ? o.sealKey : sealKey,
      http,
      now,
      defer: (p) => void deferred.push(p),
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      limits: { ...FAST, ...limits, ...o.limits },
    });
  const park = (fragment: string) => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    parked.set(fragment, { reached, gate });
    return { release, reached: arrived };
  };

  /** Stands in for the laptop CLI: signs in against the fake with the request's nonce and seals the grant to it. */
  const connect = async (request: PairingRequest, o: { nonce?: string } = {}): Promise<{ file: string; payload: ConnectionPayload }> => {
    const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const secrets = { state: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), nonce: o.nonce ?? request.nonce, verifier };
    const redirectUri = loopbackRedirectUri(49_152)!;
    const back = new URL(fake.authorize(await authorizeUrl({ client: request.client, hostId: request.hostId, redirectUri, secrets, forceConsent: request.forceConsent })));
    const q = parseCallbackQuery(back.searchParams);
    if (q?.kind !== 'code') throw new Error('no code on the callback');
    const clientId = callbackClientId(request.client, q.clientId)!;
    const laptop: OutboundFetch = (url, init) => fake.fetch(url, init);
    const done = await completeSignIn(laptop, new OpenAiDirectory({ http: laptop, now }), { clientId, code: q.code, verifier, redirectUri, nonce: secrets.nonce, now: now(), signal: AbortSignal.timeout(5_000) });
    if (!done.ok) throw new Error(`laptop sign-in failed: ${done.failure.kind}`);
    const payload: ConnectionPayload = {
      clientId,
      idToken: done.idToken,
      accessToken: done.grant.accessToken,
      refreshToken: done.grant.refreshToken,
      expiresInS: Math.floor((done.grant.expiresAt - now()) / 1000),
      earliestRefreshAt: done.grant.earliestRefreshAt,
      scopes: [...done.grant.scopes],
    };
    return { file: JSON.stringify(await sealConnection(request, payload)), payload };
  };

  const a = make();
  const b = make();
  const pair = async (acct = a, user = OWNER, o = CURRENT) => {
    const p = await acct.createPairing(user, o);
    if (!p.ok) throw new Error(`pairing refused: ${p.error}`);
    return p.request;
  };
  const signIn = async (acct = a, user = OWNER, o = CURRENT) => (await acct.install(user, (await connect(await pair(acct, user, o))).file)).outcome;
  const r = {
    fake,
    a,
    b,
    make,
    park,
    connect,
    pair,
    signIn,
    now,
    expectReuse: false,
    advance: (ms: number) => void (clock += ms),
    set: (t: number) => void (clock = t),
    row: () => new HostedStore(d1.db).read(),
    okText: (x: AiReply) => (x.ok ? x.text : `refused: ${x.code}`),
    answer: fake.behaviour.answer,
    refreshes: () => fake.log.filter((e) => e.kind === 'refresh'),
    settled: () => Promise.allSettled(deferred),
    deferredCount: () => deferred.length,
  };
  rigs.push(r);
  return r;
}

const denied = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HostedAccessError);
  expect(e).toMatchObject({ status: 403, message: HOSTED_ACCESS_MESSAGE });
  expect(String((e as Error).message)).not.toContain(OWNER);
};

describe('one owner-private Site, connected through a sealed file', () => {
  it('pairs, installs, answers on the plan, keeps no token in clear and reads status without network', async () => {
    const r = rig();
    expect(await r.a.status(OWNER)).toMatchObject({ state: 'off', signInAvailable: true, connectVia: 'file', connection: { kind: 'disconnected', registered: false }, pendingUntil: null });
    expect(await r.row()).toBeNull();
    const request = await r.pair();
    expect(request).toMatchObject({ v: 'studyai-pairing/1', client: { kind: 'dynamic' }, hostId: (await r.row())!.hostId, expiresAt: T0 + 10 * 60_000 });
    expect(JSON.stringify(request)).not.toMatch(/"d"\s*:/);
    expect((await r.a.status(OWNER)).pendingUntil).toBe(request.expiresAt);
    const { file } = await r.connect(request);
    expect(await r.b.install(OWNER, file)).toEqual({ outcome: 'connected' });

    const before = r.fake.log.length;
    expect(await r.a.status(OWNER)).toMatchObject({ state: 'ready', connection: { kind: 'connected', email: 'student@example.test' }, notice: { kind: 'sign-in', outcome: 'connected' }, pendingUntil: null });
    expect(r.fake.log.length).toBe(before);
    expect(await r.a.ask(OWNER, TASK)).toEqual({ ok: true, text: r.answer, model: 'gpt-fake-large' });

    const stored = JSON.stringify(await d1.db.prepare('SELECT * FROM chatgpt_account').first());
    for (const t of r.fake.issued()) expect(stored).not.toContain(t);
    expect((await r.row())!.ownerUserId).toBe(OWNER);
  });

  it('without the server key: status off, pairing and install refuse', async () => {
    const r = rig();
    const keyless = r.make({ sealKey: undefined });
    expect(await keyless.status(OWNER)).toMatchObject({ state: 'off', signInAvailable: false, connectVia: 'file' });
    expect(await keyless.createPairing(OWNER, CURRENT)).toEqual({ ok: false, error: 'not-configured' });
    expect(await keyless.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-not-configured' });
    const { file } = await r.connect(await r.pair());
    expect(await keyless.install(OWNER, file)).toEqual({ outcome: 'unknown-attempt' });
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'connected' });
  });
});

describe('owner binding', () => {
  it('the first install claims the owner; it survives forget, and anyone else gets one fixed 403 on every method', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    const guest = r.b;
    await denied(guest.status(OTHER));
    await denied(guest.createPairing(OTHER, CURRENT));
    await denied(guest.install(OTHER, JSON.stringify({ v: 'studyai-connection/1' })));
    await denied(guest.ask(OTHER, TASK));
    await denied(guest.models(OTHER));
    await denied(guest.selectModel(OTHER, 'gpt-fake-large'));
    await denied(guest.resume(OTHER));
    await denied(guest.disconnect(OTHER, { forget: true }));
    expect((await r.a.status(OWNER)).state).toBe('ready');

    expect(await r.a.disconnect(OWNER, { forget: true })).toEqual({ ok: true, remoteRevoked: true });
    expect((await r.row())!.ownerUserId).toBe(OWNER);
    await denied(guest.createPairing(OTHER, CURRENT));
    await denied(guest.status(OTHER));
    expect(await r.signIn(r.b)).toBe('connected');
    expect(r.fake.log.filter((e) => e.kind === 'authorize').at(-1)!.clientId).toBe('dynamic_agent_client');
  });

  it("before any install, another user's upload of the owner's file is unknown and consumes nothing", async () => {
    const r = rig();
    const { file } = await r.connect(await r.pair());
    expect(await r.b.install(OTHER, file)).toEqual({ outcome: 'unknown-attempt' });
    expect((await r.row())!.ownerUserId).toBeNull();
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'connected' });
    expect((await r.row())!.ownerUserId).toBe(OWNER);
  });
});

describe('the pairing is consumed once, and only by a real connection file', () => {
  it('the request file uploaded by mistake, or any junk, is file-invalid and leaves the pairing usable', async () => {
    const r = rig();
    const request = await r.pair();
    for (const junk of [JSON.stringify(request), request, '{}', 'not json', 'x'.repeat(70_000), null, 42]) expect(await r.a.install(OWNER, junk)).toEqual({ outcome: 'file-invalid' });
    expect((await r.a.status(OWNER)).pendingUntil).toBe(request.expiresAt);
    expect(await r.a.install(OWNER, (await r.connect(request)).file)).toEqual({ outcome: 'connected' });
  });

  it('a tampered or mis-bound file consumes its pairing and installs nothing', async () => {
    const r = rig();
    const request = await r.pair();
    const { file, payload } = await r.connect(request);
    const sealed = JSON.parse(file) as { ct: string };
    const flipped = JSON.stringify({ ...sealed, ct: `${sealed.ct.slice(0, 10)}${sealed.ct[10] === 'A' ? 'B' : 'A'}${sealed.ct.slice(11)}` });
    expect(await r.a.install(OWNER, flipped)).toEqual({ outcome: 'file-invalid' });
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'unknown-attempt' });
    expect((await r.a.status(OWNER)).connection.kind).toBe('disconnected');

    const second = await r.pair();
    const misbound = JSON.stringify(await sealConnection({ ...second, hostId: newHostId() }, payload));
    expect(await r.a.install(OWNER, misbound)).toEqual({ outcome: 'file-invalid' });
    expect((await r.a.status(OWNER)).notice).toMatchObject({ kind: 'sign-in', outcome: 'file-invalid' });
  });

  it('two instances uploading one file install it once; a replay is unknown', async () => {
    const r = rig();
    const { file } = await r.connect(await r.pair());
    const outcomes = await Promise.all([r.a.install(OWNER, file), r.b.install(OWNER, JSON.parse(file))]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['connected', 'unknown-attempt']);
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'unknown-attempt' });
    expect(r.fake.count('exchange')).toBe(1);
  });

  it('an expired pairing is refused as expired', async () => {
    const r = rig();
    const { file } = await r.connect(await r.pair());
    r.advance(10 * 60_000);
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'expired' });
    expect(await r.a.status(OWNER)).toMatchObject({ pendingUntil: null, notice: { kind: 'sign-in', outcome: 'expired' } });
  });
});

describe('the newest start wins across awaits', () => {
  /** Parks instance `a` just before it stores its pairing, after it stamped its intent. */
  const parkedBeforeStore = (r: Rig) => {
    let release!: () => void;
    const gate = new Promise<void>((g) => (release = g));
    let reached!: () => void;
    const arrived = new Promise<void>((g) => (reached = g));
    const slow = r.make({
      faults: {
        before: async (name) => {
          if (name !== 'storePairing') return;
          reached();
          await gate;
        },
      },
    });
    return { slow, release, reached: arrived };
  };

  it('a start that began first but finishes last is superseded, and the newer pairing installs', async () => {
    const r = rig();
    const p = parkedBeforeStore(r);
    const older = p.slow.createPairing(OWNER, CURRENT);
    await p.reached;
    const newer = await r.pair(r.b);
    p.release();
    expect(await older).toEqual({ ok: false, error: 'superseded' });
    expect((await r.row())!.pairing!.id).toBe(newer.pairingId);
    expect(await r.a.install(OWNER, (await r.connect(newer)).file)).toEqual({ outcome: 'connected' });
  });

  it('a disconnect during a start leaves nothing pending; an older pairing file is unknown after a newer start', async () => {
    const r = rig();
    const p = parkedBeforeStore(r);
    const starting = p.slow.createPairing(OWNER, CURRENT);
    await p.reached;
    await r.b.disconnect(OWNER, { forget: false });
    p.release();
    expect(await starting).toEqual({ ok: false, error: 'superseded' });
    expect((await r.a.status(OWNER)).pendingUntil).toBeNull();

    const first = await r.pair();
    const second = await r.pair(r.b);
    expect(await r.a.install(OWNER, (await r.connect(first)).file)).toEqual({ outcome: 'unknown-attempt' });
    expect((await r.a.status(OWNER)).pendingUntil).toBe(second.expiresAt);
    expect(await r.a.install(OWNER, (await r.connect(second)).file)).toEqual({ outcome: 'connected' });
  });
});

describe('the transferred ID token: nonce and signed iat, not wall-clock exp', () => {
  it('a token whose exp has passed installs when it was signed inside the pairing window', async () => {
    const r = rig();
    r.fake.behaviour.idTokenTtlS = 30;
    const request = await r.pair();
    r.advance(5_000);
    const { file } = await r.connect(request);
    r.advance(5 * 60_000);
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'connected' });
  });

  it('a token signed before or after the pairing window is id-token-invalid, and its grant is revoked', async () => {
    const r = rig();
    for (const signedAt of [T0 - 120_000, T0 + 11 * 60_000]) {
      r.set(T0);
      const request = await r.pair();
      r.set(signedAt);
      const { file, payload } = await r.connect(request);
      r.set(T0 + 10_000);
      expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'id-token-invalid' });
      expect(r.fake.revoked()).toContain(payload.refreshToken);
    }
    expect((await r.a.status(OWNER)).connection.kind).toBe('disconnected');
  });

  it('a token minted for another nonce is id-token-invalid', async () => {
    const r = rig();
    const { file } = await r.connect(await r.pair(), { nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) });
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'id-token-invalid' });
  });

  it('expiry is anchored at the signed iat, so a late upload does not stretch the access token', async () => {
    const r = rig();
    const { file } = await r.connect(await r.pair());
    r.advance(5 * 60_000);
    expect(await r.a.install(OWNER, file)).toEqual({ outcome: 'connected' });
    r.set(T0 + HOUR - 30_000);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
    expect(r.fake.count('refresh')).toBe(1);
  });
});

describe('install races: re-read before any revoke', () => {
  it('a disconnect while install verifies wins: superseded, and the new grant is revoked', async () => {
    const r = rig();
    const { file, payload } = await r.connect(await r.pair());
    const fresh = r.make();
    const parked = r.park('/.well-known/openid-configuration');
    const installing = fresh.install(OWNER, file);
    await parked.reached;
    await r.b.disconnect(OWNER, { forget: false });
    parked.release();
    expect(await installing).toEqual({ outcome: 'superseded' });
    expect(r.fake.revoked()).toEqual([payload.refreshToken]);
    expect((await r.a.status(OWNER)).connection.kind).toBe('disconnected');
  });

  it('a superseded reauth while the same client still has a live session is dropped, not revoked', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    const { file } = await r.connect(await r.pair());
    const fresh = r.make();
    const parked = r.park('/.well-known/openid-configuration');
    const installing = fresh.install(OWNER, file);
    await parked.reached;
    await r.pair(r.b);
    parked.release();
    expect(await installing).toEqual({ outcome: 'superseded' });
    expect(r.fake.revoked()).toEqual([]);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
  });

  it('an install whose write applied and then threw is recognised by re-reading: connected, nothing revoked', async () => {
    const r = rig();
    let thrown = false;
    const flaky = r.make({ faults: { after: (name) => {
      if (name !== 'install' || thrown) return;
      thrown = true;
      throw new Error('D1_ERROR: Network connection lost.');
    } } });
    const { file } = await r.connect(await r.pair());
    expect(await flaky.install(OWNER, file)).toEqual({ outcome: 'connected' });
    expect(thrown).toBe(true);
    expect(r.fake.revoked()).toEqual([]);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
  });

  it('another client replacing the session through an install that applied and then threw still revokes the old token', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    const oldToken = r.fake.issued().find((t) => t.startsWith('fake-rt-'))!;
    let thrown = false;
    const flaky = r.make({ faults: { after: (name) => {
      if (name !== 'install' || thrown) return;
      thrown = true;
      throw new Error('D1_ERROR: Network connection lost.');
    } } });
    const { file } = await r.connect(await r.pair(flaky, OWNER, OTHER_ACCOUNT));
    expect(await flaky.install(OWNER, file)).toEqual({ outcome: 'connected' });
    expect(thrown).toBe(true);
    expect(r.fake.revoked()).toEqual([oldToken]);
  });

  it('another account replaces the session and revokes the old token; a new account install resets refresh state', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    const oldToken = r.fake.issued().find((t) => t.startsWith('fake-rt-'))!;
    r.fake.behaviour.account = { sub: 'user-fake-2', email: 'second@example.test' };
    expect(await r.signIn(r.b, OWNER, OTHER_ACCOUNT)).toBe('connected');
    expect(r.fake.revoked()).toEqual([oldToken]);
    expect(await r.row()).toMatchObject({ refreshState: 'ok', lease: null, registration: { email: 'second@example.test' } });
  });
});

describe('rotation across instances: one send per token set', () => {
  it('R1: ten asks across two instances at expiry send exactly one refresh, and all answer', async () => {
    const r = rig({ maxConcurrent: 10 });
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? r.a : r.b).ask(OWNER, TASK)));
    expect(r.fake.count('refresh')).toBe(1);
    expect(replies.map(r.okText)).toEqual(Array<string>(10).fill(r.answer));
  });

  /** Holder `a` sends inside the refresh margin and is held after upstream rotated; the clock then passes its 60 s lease. */
  const heldPastLease = async (r: Rig, second: HostedChatGptAccount) => {
    expect(await r.signIn()).toBe('connected');
    const revBefore = (await r.row())!.creds!.rev;
    r.advance(HOUR - 30_000);
    const held = r.fake.hold('refresh');
    const first = r.a.ask(OWNER, TASK);
    await held.reached;
    r.advance(61_000);
    const late = await second.ask(OWNER, TASK);
    held.release();
    return { first: await first, late, revBefore };
  };

  it('R2: a holder that outlived its lease still commits; the waiter abandons it and never sends', async () => {
    const r = rig();
    const { first, late, revBefore } = await heldPastLease(r, r.b);
    expect(late).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    expect(r.okText(first)).toBe(r.answer);
    expect(r.fake.count('refresh')).toBe(1);
    const row = await r.row();
    expect(row).toMatchObject({ refreshState: 'ok', lease: null });
    expect(row!.creds!.rev).not.toBe(revBefore);
    expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
  });

  it('R2 mutation: a claim that accepts an expired lease resends the rotated token and loses the session', async () => {
    const r = rig();
    r.expectReuse = true;
    const mutant = r.make({ faults: { rewrite: (name, sql) => (name === 'claimRefresh' ? sql.replace('lease_id IS NULL', `(lease_id IS NULL OR lease_until < ${r.now()})`) : sql) } });
    const { first, late } = await heldPastLease(r, mutant);
    expect(r.fake.count('refresh')).toBe(2);
    expect(r.fake.reused()).toBe(1);
    expect(late).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(first).toMatchObject({ ok: false });
    expect((await r.row())!.creds).toBeNull();
  });

  it('R3: rotate-then-hang is indeterminate: answers until the access token expires, then a reauth, then one clean refresh', async () => {
    const r = rig({ refreshDeadlineMs: 50 });
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR - 30_000);
    r.fake.behaviour.nextRefresh = 'rotate-then-hang';
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
    expect(await r.row()).toMatchObject({ refreshState: 'indeterminate', lease: null });
    expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
    expect(r.fake.count('refresh')).toBe(1);

    r.advance(31_000);
    const sentBefore = r.fake.log.length;
    expect(await r.b.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(r.fake.log.length, 'nothing goes upstream with an expired access token').toBe(sentBefore);
    expect(await r.a.status(OWNER)).toMatchObject({ state: 'off', connection: { kind: 'disconnected', registered: true }, notice: { kind: 'session-ended', reason: 'refresh-indeterminate' } });
    expect(r.fake.count('refresh')).toBe(1);

    expect(await r.signIn()).toBe('connected');
    expect(r.fake.log.filter((e) => e.kind === 'authorize').at(-1)!.clientId).toMatch(/^oaiapp_fake1$/);
    expect(await r.row()).toMatchObject({ refreshState: 'ok', lease: null });
    r.advance(HOUR + 1);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
    const sent = r.refreshes();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.token).not.toBe(sent[0]!.token);
    expect(sent[1]!.rotatedTo).toBeDefined();
  });

  it('R4: rotate-then-504 is indeterminate as well; a 401 in that state ends the session instead of retrying', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR - 30_000);
    r.fake.behaviour.nextRefresh = 'rotate-then-504';
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
    expect((await r.row())!.refreshState).toBe('indeterminate');
    r.fake.invalidateAccess();
    expect(await r.b.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect((await r.a.status(OWNER)).notice).toMatchObject({ kind: 'session-ended', reason: 'refresh-indeterminate' });
    expect(r.fake.count('refresh')).toBe(1);
  });

  it('R4: a 429 or a non-terminal 400 releases the lease, and the same token refreshes successfully later', async () => {
    for (const answer of ['rate-limited', 'rejected'] as const) {
      const r = rig();
      expect(await r.signIn()).toBe('connected');
      r.advance(HOUR - 30_000);
      r.fake.behaviour.nextRefresh = answer;
      expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
      expect(await r.row()).toMatchObject({ refreshState: 'ok', lease: null });
      expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
      const [first, second] = r.refreshes();
      expect(second!.token).toBe(first!.token);
      expect(first!.rotatedTo).toBeUndefined();
      expect(second!.rotatedTo).toBeDefined();
      await r.settled();
      await d1.reset();
    }
  });

  it('R5: a disconnect during a held refresh revokes the cleared token, then the successor nobody can store', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    const held = r.fake.hold('refresh');
    const asking = r.a.ask(OWNER, TASK);
    await held.reached;
    expect(await r.b.disconnect(OWNER, { forget: false })).toEqual({ ok: true, remoteRevoked: true });
    held.release();
    expect(await asking).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    const [sent] = r.refreshes();
    expect(r.fake.revoked()).toEqual([sent!.token, sent!.rotatedTo]);
    expect(await r.a.status(OWNER)).toMatchObject({ connection: { kind: 'disconnected' }, notice: { kind: 'disconnected', remoteRevoked: true } });
  });

  it('R6a: a same-client reauth during a held refresh wins; the lost successor is dropped, never revoked', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    const held = r.fake.hold('refresh');
    const asking = r.a.ask(OWNER, TASK);
    await held.reached;
    expect(await r.signIn(r.b)).toBe('connected');
    held.release();
    expect(await asking).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    expect(r.fake.revoked()).toEqual([]);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
  });

  it('R6b: another client installed during a held refresh wins; the lost successor is revoked', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    const held = r.fake.hold('refresh');
    const asking = r.a.ask(OWNER, TASK);
    await held.reached;
    expect(await r.signIn(r.b, OWNER, OTHER_ACCOUNT)).toBe('connected');
    const live = (await r.row())!.creds!;
    held.release();
    expect(await asking).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    const [sent] = r.refreshes();
    expect(r.fake.revoked()).toContain(sent!.rotatedTo);
    expect((await r.row())!.creds).toEqual(live);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
  });

  it('R7: a commit that applied and then threw is recognised by re-reading: no revoke, state ok, next refresh clean', async () => {
    const r = rig();
    let thrown = false;
    const flaky = r.make({ faults: { after: (name) => {
      if (name !== 'commitRefresh' || thrown) return;
      thrown = true;
      throw new Error('D1_ERROR: Network connection lost.');
    } } });
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    expect(r.okText(await flaky.ask(OWNER, TASK))).toBe(r.answer);
    expect(thrown).toBe(true);
    expect(r.fake.revoked()).toEqual([]);
    expect(await r.row()).toMatchObject({ refreshState: 'ok', lease: null });
    r.advance(HOUR + 1);
    expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
    const [first, second] = r.refreshes();
    expect(second!.token).toBe(first!.rotatedTo);
  });

  it('install, refresh and disconnect are each one chain handed to defer from their first write', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    expect(r.deferredCount()).toBe(1);
    r.advance(HOUR + 1);
    await r.a.ask(OWNER, TASK);
    expect(r.deferredCount()).toBe(2);
    await r.a.disconnect(OWNER, { forget: false });
    expect(r.deferredCount()).toBe(3);
  });

  it('a refresh outlives the ask that started it: the ask times out, the deferred chain still commits', async () => {
    const r = rig({ askDeadlineMs: 50 });
    expect(await r.signIn()).toBe('connected');
    const revBefore = (await r.row())!.creds!.rev;
    r.advance(HOUR + 1);
    const held = r.fake.hold('refresh');
    const asking = r.a.ask(OWNER, TASK);
    await held.reached;
    expect(await asking).toMatchObject({ ok: false, code: 'chatgpt-timeout' });
    held.release();
    await r.settled();
    const row = await r.row();
    expect(row).toMatchObject({ refreshState: 'ok', lease: null });
    expect(row!.creds!.rev).not.toBe(revBefore);
    expect(r.fake.count('refresh')).toBe(1);
    expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
    expect(r.fake.count('refresh')).toBe(1);
  });

  it('F4: a refresh that commits between disconnect\'s read and write makes it retry and revoke only the live successor', async () => {
    const r = rig();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((g) => (release = g));
    const arrived = new Promise<void>((g) => (reached = g));
    let parkedOnce = false;
    const slow = r.make({
      faults: {
        before: async (name) => {
          if (name !== 'disconnect' || parkedOnce) return;
          parkedOnce = true;
          reached();
          await gate;
        },
      },
    });
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    const disconnecting = slow.disconnect(OWNER, { forget: false });
    await arrived;
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
    release();
    expect(await disconnecting).toEqual({ ok: true, remoteRevoked: true });
    const [sent] = r.refreshes();
    expect(r.fake.revoked()).toEqual([sent!.rotatedTo]);
    expect((await r.a.status(OWNER)).connection.kind).toBe('disconnected');
  });
});

describe('refresh answers that end the session', () => {
  it('a terminal refresh ends the session and keeps the registration for a reauth', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    r.fake.behaviour.nextRefresh = 'terminal';
    expect(await r.a.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(await r.a.status(OWNER)).toMatchObject({ connection: { kind: 'disconnected', registered: true }, notice: { kind: 'session-ended', reason: 'refresh-rejected' } });
  });

  it('invalid-client drops the registration, so the next pairing registers a new client', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    r.fake.behaviour.nextRefresh = 'invalid-client';
    expect(await r.a.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect((await r.pair()).client).toEqual({ kind: 'dynamic' });
  });

  it('a rotated but unreadable 200 is spent: the session ends after one send', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.advance(HOUR + 1);
    r.fake.behaviour.nextRefresh = 'rotate-then-garbage';
    expect(await r.a.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(await r.b.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(r.fake.count('refresh')).toBe(1);
  });

  it('a 401 forces one refresh and asks the user to resend; nothing is resent automatically', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    r.fake.invalidateAccess();
    expect(await r.a.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    expect(r.fake.count('refresh')).toBe(1);
    expect(r.fake.count('responses')).toBe(0);
    expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
  });
});

describe('asking on one instance', () => {
  it('the concurrency cap is per instance, and a disconnect stops this instance\'s streams', async () => {
    const r = rig({ askDeadlineMs: 5_000 });
    expect(await r.signIn()).toBe('connected');
    r.fake.behaviour.responses.push({ kind: 'hang' }, { kind: 'hang' });
    const hanging = [r.a.ask(OWNER, TASK), r.a.ask(OWNER, TASK)];
    await expect.poll(() => r.fake.count('responses')).toBe(2);
    expect(await r.a.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-busy' });
    expect(r.okText(await r.b.ask(OWNER, TASK))).toBe(r.answer);
    await r.a.disconnect(OWNER, { forget: false });
    expect(await Promise.all(hanging)).toEqual([expect.objectContaining({ code: 'chatgpt-aborted' }), expect.objectContaining({ code: 'chatgpt-aborted' })]);
  });

  it('models, selection and a usage-limit pause belong to the current session', async () => {
    const r = rig();
    expect(await r.signIn()).toBe('connected');
    expect(await r.a.models(OWNER)).toMatchObject({ ok: true, models: [{ slug: 'gpt-fake-large' }, { slug: 'gpt-fake-small' }], selected: null });
    expect(await r.b.selectModel(OWNER, 'gpt-fake-small')).toEqual({ ok: true });
    expect(await r.b.selectModel(OWNER, 'gpt-fake-hidden')).toMatchObject({ ok: false });
    expect((await r.a.status(OWNER)).connection).toMatchObject({ kind: 'connected', model: { slug: 'gpt-fake-small' } });
    r.fake.behaviour.responses.push({ kind: 'http', status: 429, body: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
    expect(await r.a.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-usage-limit' });
    expect(await r.b.status(OWNER)).toMatchObject({ state: 'paused' });
    expect(await r.b.ask(OWNER, TASK)).toMatchObject({ ok: false, code: 'chatgpt-paused' });
    await r.b.resume(OWNER);
    expect(r.okText(await r.a.ask(OWNER, TASK))).toBe(r.answer);
    expect(r.fake.log.filter((e) => e.kind === 'responses').at(-1)!.body!.model).toBe('gpt-fake-small');
  });
});
