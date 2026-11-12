import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newPairingId } from '../src/core/chatgpt/bridge';
import { newHostId, parseIssuedClientId, parseSubject } from '../src/core/chatgpt/oauth';
import type { ChatGptNotice } from '../src/core/tutor/contract';
import { HostedStore, newLeaseId, newRev, type D1Like, type Registration, type Rev } from '../worker/src/hosted/store';
import type { SiteUserId } from '../worker/src/sites/boundary';
import { localD1 } from './helpers/d1';

const OWNER = 'site-user-owner' as SiteUserId;
const OTHER = 'site-user-other' as SiteUserId;
const CLIENT = parseIssuedClientId('oaiapp_store1')!;
const CLIENT_2 = parseIssuedClientId('oaiapp_store2')!;
const REG: Registration = { clientId: CLIENT, subject: parseSubject('user-1'), email: 'a@example.test', planDisabled: false };
const NOTICE: ChatGptNotice = { kind: 'sign-in', outcome: 'connected', at: 1 };
const T = 1_000_000;

let d1: Awaited<ReturnType<typeof localD1>>;
let db: D1Like;
beforeAll(async () => {
  d1 = await localD1();
  db = d1.db;
});
afterAll(async () => d1.dispose());
beforeEach(async () => d1.reset());

const store = () => new HostedStore(db);

/** A row with one installed session for `user`, through the same statements the account uses. */
async function seeded(user = OWNER, clientId = CLIENT): Promise<{ s: HostedStore; rev: Rev }> {
  const s = store();
  await s.ensureRow(newHostId());
  const intent = newPairingId();
  expect(await s.beginPairing({ intent, user })).toBe(true);
  const rev = newRev();
  const before = await s.read();
  expect(await s.install({ intent, user, expectRev: before!.creds?.rev ?? null, next: { rev, clientId, sealed: 'v1.sealed' }, registration: { ...REG, clientId }, notice: NOTICE })).toBe(true);
  return { s, rev };
}

describe('the hosted row', () => {
  it('reading an absent row writes nothing; ensureRow creates it once and keeps the first host id', async () => {
    const s = store();
    expect(await s.read()).toBeNull();
    expect(await s.read()).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chatgpt_account').first<{ n: number }>()).toEqual({ n: 0 });
    const first = newHostId();
    await Promise.all([s.ensureRow(first), s.ensureRow(newHostId())]);
    await s.ensureRow(newHostId());
    expect((await s.read())!.hostId).toBe(first);
  });

  it('an unreadable JSON column reads as absent instead of failing the whole row', async () => {
    await seeded();
    await db.prepare(`UPDATE chatgpt_account SET notice_json = '{broken', pause_json = '{"code":"other"}' WHERE id = 1`).run();
    const row = await store().read();
    expect(row!.notice).toBeNull();
    expect(row!.pause).toBeNull();
    expect(row!.creds).not.toBeNull();
  });
});

describe('F3: the right to send one refresh token', () => {
  it('only one claim wins; a second, a stale-rev and an indeterminate claim all miss', async () => {
    const { s, rev } = await seeded();
    const claims = await Promise.all([0, 1, 2, 3].map(() => s.claimRefresh({ rev, leaseId: newLeaseId(), until: T + 60_000 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await s.claimRefresh({ rev: newRev(), leaseId: newLeaseId(), until: T })).toBe(false);
  });

  it('an expired lease is not free: no second claim before or after a waiter abandons it', async () => {
    const { s, rev } = await seeded();
    const holder = newLeaseId();
    expect(await s.claimRefresh({ rev, leaseId: holder, until: T })).toBe(true);
    expect(await s.claimRefresh({ rev, leaseId: newLeaseId(), until: T + 120_000 })).toBe(false);
    expect(await s.abandonStaleLease({ rev, leaseId: holder, now: T - 1 })).toBe(false);
    expect(await s.abandonStaleLease({ rev, leaseId: holder, now: T + 1 })).toBe(true);
    const row = await s.read();
    expect(row!.refreshState).toBe('indeterminate');
    expect(row!.lease).toEqual({ id: holder, until: T });
    expect(await s.claimRefresh({ rev, leaseId: newLeaseId(), until: T + 120_000 })).toBe(false);
  });

  it('the original holder still commits after its lease expired and was abandoned, which restores ok', async () => {
    const { s, rev } = await seeded();
    const holder = newLeaseId();
    await s.claimRefresh({ rev, leaseId: holder, until: T });
    await s.abandonStaleLease({ rev, leaseId: holder, now: T + 1 });
    expect(await s.commitRefresh({ rev, leaseId: newLeaseId(), next: { rev: newRev(), sealed: 'v1.x' } })).toBe(false);
    const next = newRev();
    expect(await s.commitRefresh({ rev, leaseId: holder, next: { rev: next, sealed: 'v1.next' } })).toBe(true);
    expect(await s.read()).toMatchObject({ refreshState: 'ok', lease: null, creds: { rev: next, sealed: 'v1.next' } });
    expect(await s.commitRefresh({ rev, leaseId: holder, next: { rev: newRev(), sealed: 'v1.again' } })).toBe(false);
  });

  it('release frees the rev for one new claim; indeterminate blocks every claim until a new install', async () => {
    const { s, rev } = await seeded();
    const a = newLeaseId();
    await s.claimRefresh({ rev, leaseId: a, until: T });
    expect(await s.releaseRefresh({ rev, leaseId: newLeaseId() })).toBe(false);
    expect(await s.releaseRefresh({ rev, leaseId: a })).toBe(true);
    const b = newLeaseId();
    expect(await s.claimRefresh({ rev, leaseId: b, until: T })).toBe(true);
    expect(await s.markIndeterminate({ rev, leaseId: b })).toBe(true);
    expect(await s.read()).toMatchObject({ refreshState: 'indeterminate', lease: null });
    expect(await s.claimRefresh({ rev, leaseId: newLeaseId(), until: T })).toBe(false);

    const intent = newPairingId();
    await s.beginPairing({ intent, user: OWNER });
    const fresh = newRev();
    expect(await s.install({ intent, user: OWNER, expectRev: rev, next: { rev: fresh, clientId: CLIENT, sealed: 'v1.y' }, registration: REG, notice: NOTICE })).toBe(true);
    expect(await s.read()).toMatchObject({ refreshState: 'ok', lease: null });
    expect(await s.claimRefresh({ rev: fresh, leaseId: newLeaseId(), until: T })).toBe(true);
  });

  it('only the lease holder ends a rev; dropping the registration only drops the refused client', async () => {
    const { s, rev } = await seeded();
    const lease = newLeaseId();
    await s.claimRefresh({ rev, leaseId: lease, until: T });
    const ended: ChatGptNotice = { kind: 'session-ended', reason: 'invalid-client', at: 2 };
    expect(await s.endSessionByRefresh({ rev, leaseId: newLeaseId(), dropRegistration: true, notice: ended })).toBe(false);
    const gen = (await s.read())!.generation;
    expect(await s.endSessionByRefresh({ rev, leaseId: lease, dropRegistration: true, notice: ended })).toBe(true);
    expect(await s.read()).toMatchObject({ creds: null, lease: null, refreshState: 'ok', registration: null, generation: gen + 1, notice: ended, ownerUserId: OWNER });
  });

  it('an indeterminate session ends only while still indeterminate', async () => {
    const { s, rev } = await seeded();
    const notice: ChatGptNotice = { kind: 'session-ended', reason: 'refresh-indeterminate', at: 3 };
    expect(await s.endIndeterminateSession({ rev, notice })).toBe(false);
    const lease = newLeaseId();
    await s.claimRefresh({ rev, leaseId: lease, until: T });
    await s.abandonStaleLease({ rev, leaseId: lease, now: T + 1 });
    expect(await s.endIndeterminateSession({ rev, notice })).toBe(true);
    expect(await s.read()).toMatchObject({ creds: null, lease: null, refreshState: 'ok', notice, registration: { clientId: CLIENT } });
  });
});

describe('F4: disconnect clears exactly the set it read; the owner stays', () => {
  it('misses when a refresh committed first, then clears the successor it re-read', async () => {
    const { s, rev } = await seeded();
    const lease = newLeaseId();
    await s.claimRefresh({ rev, leaseId: lease, until: T });
    const next = newRev();
    await s.commitRefresh({ rev, leaseId: lease, next: { rev: next, sealed: 'v1.n' } });
    const disconnected: ChatGptNotice = { kind: 'disconnected', remoteRevoked: null, at: 4 };
    expect(await s.disconnect({ expectRev: rev, forget: false, notice: disconnected })).toBeNull();
    const op = await s.disconnect({ expectRev: next, forget: false, notice: disconnected });
    expect(op).toBe((await s.read())!.op);
    expect(await s.read()).toMatchObject({ creds: null, registration: { clientId: CLIENT }, ownerUserId: OWNER, notice: disconnected });
  });

  it('forget drops the registration and model but never the owner; another user still cannot pair or install', async () => {
    const { s, rev } = await seeded();
    await s.selectModel({ generation: (await s.read())!.generation, slug: 'gpt-fake-large' });
    expect(await s.disconnect({ expectRev: rev, forget: true, notice: null })).not.toBeNull();
    expect(await s.read()).toMatchObject({ registration: null, model: null, ownerUserId: OWNER, creds: null, notice: NOTICE });
    const intent = newPairingId();
    expect(await s.beginPairing({ intent, user: OTHER })).toBe(false);
    expect(await s.beginPairing({ intent, user: OWNER })).toBe(true);
    expect(await s.install({ intent, user: OTHER, expectRev: null, next: { rev: newRev(), clientId: CLIENT_2, sealed: 'v1.z' }, registration: { ...REG, clientId: CLIENT_2 }, notice: NOTICE })).toBe(false);
    expect((await s.read())!.ownerUserId).toBe(OWNER);
  });

  it('with nothing stored, disconnect keeps the last notice', async () => {
    const s = store();
    await s.ensureRow(newHostId());
    expect(await s.disconnect({ expectRev: null, forget: false, notice: null })).toBe(1);
    expect((await s.read())!.notice).toBeNull();
  });
});

describe('pairings: newest start, one consumer, owner-bound install', () => {
  it('a pairing is stored only while its start is still the newest', async () => {
    const s = store();
    await s.ensureRow(newHostId());
    const older = newPairingId();
    const newer = newPairingId();
    await s.beginPairing({ intent: older, user: OWNER });
    await s.beginPairing({ intent: newer, user: OWNER });
    const p = (id: typeof older) => ({ id, userId: OWNER, createdAt: T, expiresAt: T + 600_000, purpose: 'new' as const, clientId: null, sealed: `v1.${id}` });
    expect(await s.storePairing(p(older))).toBe(false);
    expect(await s.storePairing(p(newer))).toBe(true);
    expect((await s.read())!.pairing).toMatchObject({ id: newer, userId: OWNER });
  });

  it('exactly one consumer wins; a wrong user, a wrong key copy or an expired pairing consumes nothing', async () => {
    const s = store();
    await s.ensureRow(newHostId());
    const id = newPairingId();
    await s.beginPairing({ intent: id, user: OWNER });
    await s.storePairing({ id, userId: OWNER, createdAt: T, expiresAt: T + 600_000, purpose: 'new', clientId: null, sealed: 'v1.key' });
    expect(await s.consumePairing({ pairingId: id, user: OTHER, sealed: 'v1.key', now: T })).toBe(false);
    expect(await s.consumePairing({ pairingId: id, user: OWNER, sealed: 'v1.other', now: T })).toBe(false);
    expect(await s.consumePairing({ pairingId: id, user: OWNER, sealed: 'v1.key', now: T + 600_000 })).toBe(false);
    const wins = await Promise.all([0, 1, 2].map(() => s.consumePairing({ pairingId: id, user: OWNER, sealed: 'v1.key', now: T })));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await s.read()).toMatchObject({ pairing: null, intent: id });
  });

  it('the first install claims the owner atomically; a rev that moved makes install miss', async () => {
    const s = store();
    await s.ensureRow(newHostId());
    const id = newPairingId();
    await s.beginPairing({ intent: id, user: OWNER });
    expect(await s.install({ intent: id, user: OWNER, expectRev: newRev(), next: { rev: newRev(), clientId: CLIENT, sealed: 'v1.a' }, registration: REG, notice: NOTICE })).toBe(false);
    expect((await s.read())!.ownerUserId).toBeNull();
    expect(await s.install({ intent: id, user: OWNER, expectRev: null, next: { rev: newRev(), clientId: CLIENT, sealed: 'v1.a' }, registration: REG, notice: NOTICE })).toBe(true);
    expect(await s.read()).toMatchObject({ ownerUserId: OWNER, intent: null, registration: REG });
  });
});

describe('per-session writes', () => {
  it('pause, model cache and selection written for an older generation are dropped', async () => {
    const { s, rev } = await seeded();
    const gen = (await s.read())!.generation;
    expect(await s.setPause({ generation: gen, pause: { code: 'usage-limit', since: 5 } })).toBe(true);
    expect(await s.cacheModels({ generation: gen, models: [{ slug: 'm', displayName: 'M' }] })).toBe(true);
    expect(await s.read()).toMatchObject({ pause: { code: 'usage-limit', since: 5 }, models: { generation: gen, list: [{ slug: 'm', displayName: 'M' }] } });
    await s.disconnect({ expectRev: rev, forget: false, notice: null });
    expect(await s.setPause({ generation: gen, pause: { code: 'usage-limit', since: 6 } })).toBe(false);
    expect(await s.cacheModels({ generation: gen, models: [] })).toBe(false);
    expect(await s.selectModel({ generation: gen, slug: 'm' })).toBe(false);
    expect(await s.read()).toMatchObject({ pause: null, models: null });
  });

  it('a notice is written only for the newest operation', async () => {
    const { s } = await seeded();
    const op = (await s.read())!.op;
    await s.beginPairing({ intent: newPairingId(), user: OWNER });
    expect(await s.putNotice({ op, notice: { kind: 'disconnected', remoteRevoked: true, at: 9 } })).toBe(false);
    expect(await s.putNotice({ op: op + 1, notice: { kind: 'disconnected', remoteRevoked: true, at: 9 } })).toBe(true);
  });
});
