import { describe, expect, it, vi } from 'vitest';
import { ChatGptAccount, CHATGPT_KEYS, decideSignIn, type ChatGptDeps, type StartOptions } from '../worker/src/chatgpt';
import { parseLoopback } from '../worker/src/loopback';
import { toBase64Url } from '../worker/src/encoding';
import { parseCallbackQuery, parseIssuedClientId, parseSubject } from '../src/core/chatgpt/oauth';
import { CHATGPT_REPLY } from '../src/core/chatgpt/messages';
import type { AiReply, AiTask } from '../src/core/tutor/contract';
import { createFakeOpenAi } from './helpers/fake-openai.mjs';

const LB = '127.0.0.1:8790';
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const TASK: AiTask = { task: 'tutor', mode: 'explain', question: '테이프가 뭔가요?', excerpts: [{ ref: 'S1', lectureTitle: 'L1', slide: 1, title: 'Tape', text: 'The tape is unbounded.' }], history: [] };
const CURRENT: StartOptions = { account: 'current', forceConsent: false };

function rig(limits: ChatGptDeps['limits'] = {}) {
  let clock = T0;
  const fake = createFakeOpenAi({ now: () => clock });
  const store = new Map<string, string>();
  const kv = { get: (k: string) => store.get(k), put: (k: string, v: string) => void store.set(k, v), del: (k: string) => void store.delete(k) };
  const sealKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const make = (over: Partial<ChatGptDeps> = {}) =>
    new ChatGptAccount({
      kv,
      http: (url, init) => fake.fetch(url, init),
      sealKey,
      loopback: parseLoopback({ STUDYAI_LOOPBACK: LB }),
      now: () => clock,
      browserUrl: (u) => u,
      sleep: async () => {},
      limits,
      ...over,
    });
  const acct = make();
  const follow = (a: ChatGptAccount, url: string) => a.callback(parseCallbackQuery(new URL(fake.authorize(url)).searchParams));
  const signIn = async (a = acct, o: StartOptions = CURRENT) => {
    const s = await a.start(o);
    if (!s.ok) throw new Error(`start refused: ${s.error}`);
    return follow(a, s.authorizeUrl);
  };
  const okText = (r: AiReply) => (r.ok ? r.text : `refused: ${r.code}`);
  return { fake, store, kv, acct, make, signIn, follow, okText, advance: (ms: number) => void (clock += ms), now: () => clock };
}

const refreshes = (fake: ReturnType<typeof createFakeOpenAi>) => fake.count('refresh');

describe('the ChatGPT account: one sign-in, end to end', () => {
  it('connects, answers on the plan with no dollar field, keeps no token in clear and survives a restart', async () => {
    const r = rig();
    expect(r.acct.status().connection).toEqual({ kind: 'disconnected', registered: false, email: null });
    expect(await r.signIn()).toBe('connected');
    const fetchesBefore = r.fake.log.length;
    expect(r.acct.status()).toMatchObject({ state: 'ready', reasons: [], signInAvailable: true, connection: { kind: 'connected', email: 'student@example.test' }, notice: { kind: 'sign-in', outcome: 'connected' } });
    expect(r.acct.gate()).toEqual({ state: 'ready', reasons: [] });
    expect(r.fake.log.length).toBe(fetchesBefore); // status and gate never touch the network

    const reply = await r.acct.ask(TASK);
    expect(reply).toEqual({ ok: true, text: r.fake.behaviour.answer, model: 'gpt-fake-large' });
    const sent = r.fake.log.find((e) => e.kind === 'responses')!.body!;
    expect(sent).toMatchObject({ model: 'gpt-fake-large', store: false, stream: true });
    for (const k of ['temperature', 'max_output_tokens', 'previous_response_id']) expect(sent).not.toHaveProperty(k);
    expect(r.fake.log.find((e) => e.kind === 'authorize')).toMatchObject({ clientId: 'dynamic_agent_client', agentNameHint: 'StudyAI', hasIdTokenHint: false });

    const everything = [...r.store.values()].join('\n') + JSON.stringify(r.acct.status());
    for (const t of r.fake.issued()) expect(everything).not.toContain(t);

    const restarted = r.make();
    expect(r.okText(await restarted.ask(TASK))).toBe(r.fake.behaviour.answer);
    expect(r.fake.count('exchange')).toBe(1);
  });

  it('a second sign-in reuses the issued client without the name hint, and reauth asks for no new registration', async () => {
    const r = rig();
    await r.signIn();
    expect(await r.signIn()).toBe('connected');
    const second = r.fake.log.filter((e) => e.kind === 'authorize')[1]!;
    expect(second.clientId).toMatch(/^oaiapp_fake1$/);
    expect(second.agentNameHint).toBeNull();
  });

  it('a different seal key cannot read the stored tokens and ends the session instead of failing forever', async () => {
    const r = rig();
    await r.signIn();
    const other = r.make({ sealKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) });
    expect(await other.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(other.status().notice).toMatchObject({ kind: 'session-ended', reason: 'unreadable' });
  });

  it('without loopback or a seal key, start refuses and the callback fails closed', async () => {
    const r = rig();
    const hosted = r.make({ loopback: null });
    expect(await hosted.start(CURRENT)).toEqual({ ok: false, error: 'loopback-only' });
    expect(await r.make({ sealKey: 'short' }).start(CURRENT)).toEqual({ ok: false, error: 'not-configured' });
    expect(await hosted.callback(parseCallbackQuery(new URLSearchParams('state=x&code=y')))).toBe('unknown-attempt');
    expect(hosted.status().signInAvailable).toBe(false);
  });
});

describe('F1: the newest start or a disconnect wins over a start still in progress', () => {
  it('of two concurrent starts only the newest stays pending, whichever finishes first', async () => {
    const r = rig();
    const first = r.acct.start(CURRENT);
    const second = r.acct.start(CURRENT);
    const [b, a] = [await second, await first];
    expect(a).toEqual({ ok: false, error: 'superseded' });
    expect(b.ok).toBe(true);
    if (b.ok) expect(await r.follow(r.acct, b.authorizeUrl)).toBe('connected');
  });

  it('start, then disconnect, then the start finishing writes nothing', async () => {
    const r = rig();
    const pending = r.acct.start(CURRENT);
    await r.acct.disconnect({ forget: false });
    expect(await pending).toEqual({ ok: false, error: 'superseded' });
    expect(r.acct.status().pendingUntil).toBeNull();
  });

  it('an older attempt whose URL is followed after a newer start is unknown and changes nothing', async () => {
    const r = rig();
    const old = await r.acct.start(CURRENT);
    await r.acct.start(CURRENT);
    if (!old.ok) throw new Error('start');
    const noticeBefore = r.acct.status().notice;
    expect(await r.follow(r.acct, old.authorizeUrl)).toBe('unknown-attempt');
    expect(r.acct.status().notice).toEqual(noticeBefore);
    expect(r.acct.status().pendingUntil).not.toBeNull();
  });
});

describe('the callback is single-use and state-authenticated', () => {
  it('a junk state neither consumes the real attempt nor writes a notice; a replay is unknown', async () => {
    const r = rig();
    const s = await r.acct.start(CURRENT);
    if (!s.ok) throw new Error('start');
    expect(await r.acct.callback(parseCallbackQuery(new URLSearchParams('state=forged&code=x')))).toBe('unknown-attempt');
    expect(r.acct.status().notice).toBeNull();
    const back = new URL(r.fake.authorize(s.authorizeUrl));
    expect(await r.acct.callback(parseCallbackQuery(back.searchParams))).toBe('connected');
    expect(await r.acct.callback(parseCallbackQuery(back.searchParams))).toBe('unknown-attempt');
    expect(r.fake.count('exchange')).toBe(1);
  });

  it('expires after ten minutes, and a denial is recorded without touching a working account', async () => {
    const r = rig();
    const s = await r.acct.start(CURRENT);
    if (!s.ok) throw new Error('start');
    const back = new URL(r.fake.authorize(s.authorizeUrl));
    r.advance(10 * 60_000);
    expect(await r.acct.callback(parseCallbackQuery(back.searchParams))).toBe('expired');

    await r.signIn();
    const again = await r.acct.start(CURRENT);
    if (!again.ok) throw new Error('start');
    const state = new URL(again.authorizeUrl).searchParams.get('state')!;
    expect(await r.acct.callback(parseCallbackQuery(new URLSearchParams({ state, error: 'access_denied' })))).toBe('denied');
    expect(r.acct.status().connection.kind).toBe('connected');
  });

  it('a new registration without an oaiapp_ client id is refused; a reauth that returns another client id too', async () => {
    const r = rig();
    const s = await r.acct.start(CURRENT);
    if (!s.ok) throw new Error('start');
    const back = new URL(r.fake.authorize(s.authorizeUrl));
    back.searchParams.delete('client_id');
    expect(await r.acct.callback(parseCallbackQuery(back.searchParams))).toBe('registration-incomplete');
    await r.signIn();
    const re = await r.acct.start(CURRENT);
    if (!re.ok) throw new Error('start');
    const reBack = new URL(r.fake.authorize(re.authorizeUrl));
    reBack.searchParams.set('client_id', 'oaiapp_someoneelse');
    expect(await r.acct.callback(parseCallbackQuery(reBack.searchParams))).toBe('client-mismatch');
    expect(r.acct.status().connection.kind).toBe('connected');
  });
});

describe('a failed code exchange', () => {
  it('a failed first exchange keeps the issued client, so the retry does not register again', async () => {
    const r = rig();
    r.fake.behaviour.nextExchange = 'invalid-grant';
    expect(await r.signIn()).toBe('code-rejected');
    expect(r.acct.status().connection).toEqual({ kind: 'disconnected', registered: true, email: null });
    expect(await r.signIn()).toBe('connected');
    expect(r.fake.log.filter((e) => e.kind === 'authorize').map((e) => e.clientId)).toEqual(['dynamic_agent_client', 'oaiapp_fake1']);
  });

  it('a failure while connected leaves the working credentials', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.nextExchange = 'transient';
    expect(await r.signIn()).toBe('upstream-unavailable');
    expect(r.okText(await r.acct.ask(TASK))).toBe(r.fake.behaviour.answer);
  });

  it('invalid_client forgets the registration, so the next start registers anew', async () => {
    const r = rig();
    r.fake.behaviour.nextExchange = 'invalid-client';
    expect(await r.signIn()).toBe('client-invalid');
    expect(r.acct.status().connection).toEqual({ kind: 'disconnected', registered: false, email: null });
    expect(await r.signIn()).toBe('connected');
    expect(r.fake.log.filter((e) => e.kind === 'authorize').map((e) => e.clientId)).toEqual(['dynamic_agent_client', 'dynamic_agent_client']);
  });
});

describe('F2: late results of an attempt write nothing once it is stale', () => {
  it('forget during the code exchange is not undone: no registration, no tokens, new token revoked', async () => {
    const r = rig();
    const s = await r.acct.start(CURRENT);
    if (!s.ok) throw new Error('start');
    const held = r.fake.hold('exchange');
    const done = r.follow(r.acct, s.authorizeUrl);
    await held.reached;
    await r.acct.disconnect({ forget: true });
    held.release();
    expect(await done).toBe('superseded');
    expect(r.acct.status().connection).toEqual({ kind: 'disconnected', registered: false, email: null });
    expect(r.store.has('chatgpt:creds')).toBe(false);
    await vi.waitFor(() => expect(r.fake.count('revoke')).toBe(1));
  });

  it('a newer start during the exchange makes the older success apply nothing and write no notice', async () => {
    const r = rig();
    const s = await r.acct.start(CURRENT);
    if (!s.ok) throw new Error('start');
    const held = r.fake.hold('exchange');
    const done = r.follow(r.acct, s.authorizeUrl);
    await held.reached;
    await r.acct.start(CURRENT);
    held.release();
    expect(await done).toBe('superseded');
    expect(r.acct.status().notice).toBeNull();
    expect(r.store.has('chatgpt:creds')).toBe(false);
  });
});

describe('refresh: single flight, revisions and the expiry rule', () => {
  it('two asks that both need a refresh make one token request', async () => {
    const r = rig();
    await r.signIn();
    r.advance(3_600_000);
    const [a, b] = await Promise.all([r.acct.ask(TASK), r.acct.ask(TASK)]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(refreshes(r.fake)).toBe(1);
  });

  it('F3: a 401 on an old token set neither refreshes nor clears the newer one', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.responses.push({ kind: 'http', status: 401, body: { detail: 'Unauthorized' } }, { kind: 'text' });
    const held = r.fake.hold('responses');
    const a = r.acct.ask(TASK);
    await held.reached;
    r.advance(3_600_000);
    const b = await r.acct.ask(TASK);
    expect(b.ok).toBe(true);
    expect(refreshes(r.fake)).toBe(1);
    held.release();
    expect(await a).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    expect(refreshes(r.fake)).toBe(1);
    expect(r.okText(await r.acct.ask(TASK))).toBe(r.fake.behaviour.answer);
    expect(refreshes(r.fake)).toBe(1);
  });

  it('a 401 on the current token set refreshes once and asks the student to resend, without resending', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.responses.push({ kind: 'http', status: 401, body: { detail: 'Unauthorized' } });
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    expect(refreshes(r.fake)).toBe(1);
    expect(r.fake.count('responses')).toBe(1);
  });

  it('F4: an older refresh settling does not clear the newer one in flight', async () => {
    const r = rig();
    r.fake.behaviour.expiresIn = 30;
    await r.signIn();
    const first = r.fake.hold('refresh');
    const a = r.acct.ask(TASK);
    await first.reached;
    expect(await r.signIn()).toBe('connected');
    expect(await a).toMatchObject({ ok: false, code: 'chatgpt-aborted' });
    const second = r.fake.hold('refresh');
    const b = r.acct.ask(TASK);
    await second.reached;
    expect(refreshes(r.fake)).toBe(2);
    first.release();
    await new Promise((res) => setTimeout(res, 10));
    const c = r.acct.ask(TASK);
    await new Promise((res) => setTimeout(res, 10));
    expect(refreshes(r.fake)).toBe(2);
    second.release();
    expect([(await b).ok, (await c).ok]).toEqual([true, true]);
    expect(refreshes(r.fake)).toBe(2);
    expect(r.fake.count('revoke')).toBe(0); // G1: the stale refresh's rotated token is dropped, not revoked, while the same client is live
  });

  it('F5: an expired token refreshes once even when earliest_refresh_at is far in the future', async () => {
    const r = rig();
    r.fake.behaviour.earliestRefreshAt = Math.floor(T0 / 1000) + 10 * 365 * 86_400;
    await r.signIn();
    r.advance(3_600_000 + 1);
    expect((await r.acct.ask(TASK)).ok).toBe(true);
    expect(refreshes(r.fake)).toBe(1);
  });

  it('within the last minute, a future earliest_refresh_at keeps using the still-valid token', async () => {
    const r = rig();
    r.fake.behaviour.earliestRefreshAt = Math.floor(T0 / 1000) + 3_600;
    await r.signIn();
    r.advance(3_600_000 - 30_000);
    expect((await r.acct.ask(TASK)).ok).toBe(true);
    expect(refreshes(r.fake)).toBe(0);
  });

  it('disconnect during a refresh: credentials stay cleared and the rotated token is revoked', async () => {
    const r = rig();
    await r.signIn();
    r.advance(3_600_000);
    const held = r.fake.hold('refresh');
    const a = r.acct.ask(TASK);
    await held.reached;
    await r.acct.disconnect({ forget: false });
    held.release();
    expect(await a).toMatchObject({ ok: false, code: 'chatgpt-aborted' });
    await vi.waitFor(() => expect(r.fake.count('revoke')).toBe(2));
    expect(r.store.has('chatgpt:creds')).toBe(false);
    expect(r.acct.status().connection).toMatchObject({ kind: 'disconnected', registered: true });
  });

  it('a terminal answer to an old refresh leaves a newer sign-in untouched', async () => {
    const r = rig();
    await r.signIn();
    r.advance(3_600_000);
    r.fake.behaviour.nextRefresh = 'terminal';
    const held = r.fake.hold('refresh');
    const a = r.acct.ask(TASK);
    await held.reached;
    expect(await r.signIn()).toBe('connected');
    held.release();
    await a;
    expect(r.acct.status().connection.kind).toBe('connected');
    expect(r.okText(await r.acct.ask(TASK))).toBe(r.fake.behaviour.answer);
  });

  it('a terminal refresh ends the session but keeps the registration; invalid_client forgets it', async () => {
    const r = rig();
    await r.signIn();
    r.advance(3_600_000);
    r.fake.behaviour.nextRefresh = 'terminal';
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(r.acct.status()).toMatchObject({ connection: { kind: 'disconnected', registered: true }, notice: { kind: 'session-ended', reason: 'refresh-rejected' } });
    expect(r.acct.gate().reasons[0]).toMatch(/만료/);

    await r.signIn();
    r.advance(3_600_000);
    r.fake.behaviour.nextRefresh = 'invalid-client';
    await r.acct.ask(TASK);
    expect(r.acct.status()).toMatchObject({ connection: { kind: 'disconnected', registered: false }, notice: { kind: 'session-ended', reason: 'invalid-client' } });
  });

  it('a temporary refresh failure keeps the credentials', async () => {
    const r = rig();
    await r.signIn();
    r.advance(3_600_000);
    r.fake.behaviour.nextRefresh = 'transient';
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-unavailable' });
    expect(r.acct.status().connection.kind).toBe('connected');
    expect((await r.acct.ask(TASK)).ok).toBe(true);
  });
});

describe('G1: revocation only when no live session of the same client remains', () => {
  it('a reauth within the same client drops the old token unrevoked; disconnect revokes', async () => {
    const r = rig();
    await r.signIn();
    await r.signIn();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.fake.count('revoke')).toBe(0);
    const d = await r.acct.disconnect({ forget: false });
    expect(d).toEqual({ ok: true, remoteRevoked: true });
    expect(r.fake.count('revoke')).toBe(1);
    expect(r.acct.status().notice).toMatchObject({ kind: 'disconnected', remoteRevoked: true });
    expect(r.acct.status().connection).toMatchObject({ kind: 'disconnected', registered: true, email: 'student@example.test' });
  });

  it('"another account" keeps the working session until the new one verifies, then revokes the old client', async () => {
    const r = rig();
    await r.signIn();
    const s = await r.acct.start({ account: 'other', forceConsent: false });
    if (!s.ok) throw new Error('start');
    expect(r.acct.status().connection.kind).toBe('connected');
    const state = new URL(s.authorizeUrl).searchParams.get('state')!;
    expect(await r.acct.callback(parseCallbackQuery(new URLSearchParams({ state, error: 'access_denied' })))).toBe('denied');
    expect(r.okText(await r.acct.ask(TASK))).toBe(r.fake.behaviour.answer);

    r.fake.behaviour.account = { sub: 'user-fake-2', email: 'other@example.test' };
    expect(await r.signIn(r.acct, { account: 'other', forceConsent: false })).toBe('connected');
    expect(r.acct.status().connection).toMatchObject({ kind: 'connected', email: 'other@example.test' });
    await vi.waitFor(() => expect(r.fake.log.filter((e) => e.kind === 'revoke').map((e) => e.clientId)).toEqual(['oaiapp_fake1']));
  });

  it('a slow revocation does not overwrite the notice of a newer sign-in', async () => {
    const r = rig();
    await r.signIn();
    const held = r.fake.hold('revoke');
    const d = r.acct.disconnect({ forget: false });
    await held.reached;
    expect(await r.signIn()).toBe('connected');
    held.release();
    await d;
    expect(r.acct.status().notice).toMatchObject({ kind: 'sign-in', outcome: 'connected' });
  });
});

describe('G2: identity checks and an identity-only sign-in', () => {
  it('a reauth that verifies another account changes nothing', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.account = { sub: 'user-intruder', email: 'x@example.test' };
    expect(await r.signIn()).toBe('account-mismatch');
    expect(r.acct.status().connection).toMatchObject({ kind: 'connected', email: 'student@example.test' });
  });

  it('no plan scope and no session: the account is recorded as plan-disabled, no tokens, the scopeless token revoked', async () => {
    const r = rig();
    r.fake.behaviour.grantPlan = false;
    expect(await r.signIn()).toBe('plan-not-enabled');
    expect(r.acct.status().connection).toEqual({ kind: 'plan-disabled', email: 'student@example.test' });
    expect(r.acct.gate().state).toBe('off');
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-plan-disabled' });
    expect(r.store.has('chatgpt:creds')).toBe(false);
    await vi.waitFor(() => expect(r.fake.count('revoke')).toBe(1));

    r.fake.behaviour.grantPlan = true;
    expect(await r.signIn(r.acct, { account: 'current', forceConsent: true })).toBe('connected');
    expect(r.fake.log.filter((e) => e.kind === 'authorize').at(-1)?.prompt).toBe('consent');
    expect(r.acct.status().connection.kind).toBe('connected');
  });

  it('no plan scope while a session works: nothing changes and the same-client token is not revoked', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.grantPlan = false;
    expect(await r.signIn()).toBe('plan-not-enabled');
    expect(r.acct.status().connection.kind).toBe('connected');
    await new Promise((res) => setTimeout(res, 10));
    expect(r.fake.count('revoke')).toBe(0);
  });

  it('no plan scope from a different returning account is an account mismatch, not a plan-disabled record', async () => {
    const r = rig();
    await r.signIn();
    await r.acct.disconnect({ forget: false });
    r.fake.behaviour.grantPlan = false;
    r.fake.behaviour.account = { sub: 'user-intruder', email: 'x@example.test' };
    expect(await r.signIn()).toBe('account-mismatch');
    expect(r.acct.status().connection).toEqual({ kind: 'disconnected', registered: true, email: 'student@example.test' });
  });

  it('decideSignIn is the policy in one place', () => {
    const c1 = parseIssuedClientId('oaiapp_one')!;
    const c2 = parseIssuedClientId('oaiapp_two')!;
    const me = { subject: parseSubject('me')!, email: 'me@example.test', issuedAt: 0 };
    const reg = { clientId: c1, subject: me.subject, email: me.email, planDisabled: false };
    expect(decideSignIn({ purpose: 'reauth', registration: reg, liveClientId: c1, attemptClientId: c1, result: { kind: 'granted', identity: me } })).toMatchObject({ outcome: 'connected', install: true, revokeOld: false, revokeNew: false });
    expect(decideSignIn({ purpose: 'new', registration: reg, liveClientId: c1, attemptClientId: c2, result: { kind: 'granted', identity: { ...me, subject: parseSubject('you')! } } })).toMatchObject({ outcome: 'connected', revokeOld: true });
    expect(decideSignIn({ purpose: 'new', registration: reg, liveClientId: c1, attemptClientId: c2, result: { kind: 'plan-not-granted', identity: me } })).toMatchObject({ outcome: 'plan-not-enabled', install: false, registration: 'keep', revokeNew: true });
  });
});

describe('asking: deadlines, aborts, limits and the concurrency slot', () => {
  it('the slot is taken before the first await: a third concurrent ask is refused at once', async () => {
    const r = rig();
    await r.signIn();
    r.fake.hold('responses');
    r.fake.hold('responses');
    const asks = [r.acct.ask(TASK), r.acct.ask(TASK), r.acct.ask(TASK)];
    expect(await asks[2]).toMatchObject({ ok: false, code: 'chatgpt-busy' });
    await r.acct.disconnect({ forget: false });
    for (const a of asks.slice(0, 2)) expect(await a).toMatchObject({ ok: false, code: 'chatgpt-aborted' });
  });

  it('the total deadline covers the token check and reads as a timeout, not a disconnect', async () => {
    const r = rig({ askDeadlineMs: 50 });
    await r.signIn();
    r.fake.behaviour.responses.push({ kind: 'hang' });
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-timeout' });
    r.advance(3_600_000);
    r.fake.hold('refresh');
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-timeout' });
  });

  it('a usage limit pauses this session only, never falls back, and the owner resumes it', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.responses.push({ kind: 'http', status: 429, body: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-usage-limit' });
    expect(r.acct.gate().state).toBe('paused');
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: false, code: 'chatgpt-paused' });
    r.acct.resume();
    expect(r.acct.gate().state).toBe('ready');

    r.fake.behaviour.responses.push({ kind: 'failed', code: 'subscription_sharing_usage_limit_exceeded' });
    await r.acct.ask(TASK);
    expect(r.acct.gate().state).toBe('paused');
    await r.signIn();
    expect(r.acct.gate().state).toBe('ready');
  });

  it('every failure is a typed reply with a fixed Korean message, never upstream text, and never 401', async () => {
    const r = rig();
    await r.signIn();
    r.fake.behaviour.responses.push({ kind: 'http', status: 500, body: { error: { code: 'server_error', message: 'SECRET UPSTREAM DETAIL' } } });
    const reply = await r.acct.ask(TASK);
    expect(reply).toEqual({ ok: false, code: 'chatgpt-unavailable', message: CHATGPT_REPLY['chatgpt-unavailable'].message });
  });
});

describe('models', () => {
  it('lists the account catalog in order, selects only from it, and the ask uses the choice', async () => {
    const r = rig();
    await r.signIn();
    expect(r.acct.selectModel('gpt-fake-small')).toMatchObject({ ok: false });
    expect(await r.acct.models()).toEqual({
      ok: true,
      models: [
        { slug: 'gpt-fake-large', displayName: 'Fake Large' },
        { slug: 'gpt-fake-small', displayName: 'Fake Small' },
      ],
      selected: null,
    });
    expect(r.acct.selectModel('gpt-fake-hidden')).toMatchObject({ ok: false });
    expect(r.acct.selectModel('gpt-fake-small')).toEqual({ ok: true });
    expect(r.acct.status().connection).toMatchObject({ model: { slug: 'gpt-fake-small', displayName: 'Fake Small' } });
    expect(await r.acct.ask(TASK)).toMatchObject({ ok: true, model: 'gpt-fake-small' });
  });

  it('a model-list 401 refreshes once and asks to retry; the retry then works', async () => {
    const r = rig();
    await r.signIn();
    r.fake.invalidateAccess();
    expect(await r.acct.models()).toMatchObject({ ok: false, code: 'chatgpt-auth-retry' });
    expect(refreshes(r.fake)).toBe(1);
    expect((await r.acct.models()).ok).toBe(true);
  });

  it('a model-list 401 whose refresh is refused ends the session instead of looping', async () => {
    const r = rig();
    await r.signIn();
    r.fake.invalidateAccess();
    r.fake.behaviour.nextRefresh = 'terminal';
    expect(await r.acct.models()).toMatchObject({ ok: false, code: 'chatgpt-signin-required' });
    expect(r.acct.status().connection.kind).toBe('disconnected');
  });

  it('owns exactly the keys it declares', async () => {
    const r = rig();
    await r.signIn();
    await r.acct.models();
    for (const k of r.store.keys()) expect(CHATGPT_KEYS, k).toContain(k);
  });

  it('keeps the row names an existing local state was written with, so a connected account is found after an upgrade', () => {
    expect([...CHATGPT_KEYS].sort()).toEqual(['chatgpt:creds', 'chatgpt:generation', 'chatgpt:host', 'chatgpt:intent', 'chatgpt:model', 'chatgpt:models', 'chatgpt:notice', 'chatgpt:op', 'chatgpt:pause', 'chatgpt:pending', 'chatgpt:registration']);
  });
});
