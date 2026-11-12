import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runConnect } from '../src/cli/connect';
import { newPairingId, newPairingKeys, openConnection, parseSealedConnection, type PairingRequest } from '../src/core/chatgpt/bridge';
import { newHostId, OpenAiDirectory, parseIssuedClientId, type OutboundFetch } from '../src/core/chatgpt/oauth';
import { createFakeOpenAi, type FakeOpenAi } from './helpers/fake-openai.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function get(url: string, o: { host?: string; method?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: o.method ?? 'GET', headers: { host: o.host ?? u.host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

function accepting(port: string): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port: Number(port) });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });
}

type Client = PairingRequest['client'];

async function setup(o: { client?: Client; expiresInMs?: number; args?: string[]; waitMs?: number; fake?: FakeOpenAi; onUrl?: (url: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'studyai-connect-'));
  dirs.push(dir);
  const fake = o.fake ?? createFakeOpenAi();
  const keys = await newPairingKeys();
  const createdAt = Date.now();
  const request: PairingRequest = {
    v: 'studyai-pairing/1',
    pairingId: newPairingId(),
    hostId: newHostId(),
    nonce: 'pairing-nonce-'.padEnd(43, 'x'),
    client: o.client ?? { kind: 'dynamic' },
    forceConsent: false,
    publicKey: keys.publicJwk,
    expiresAt: createdAt + (o.expiresInMs ?? 10 * 60_000),
  };
  const requestPath = join(dir, 'studyai-pairing.json');
  writeFileSync(requestPath, JSON.stringify(request));
  const out: string[] = [];
  const err: string[] = [];
  const shown: string[] = [];
  let listeningWhenShown: Promise<boolean> | null = null;
  let resolveUrl!: (u: string) => void;
  const url = new Promise<string>((r) => (resolveUrl = r));
  const start = (argv = [requestPath, ...(o.args ?? [])]) =>
    runConnect(argv, {
      http: fake.fetch as OutboundFetch,
      now: Date.now,
      presentAuthorizeUrl: (u) => {
        shown.push(u);
        listeningWhenShown = accepting(new URL(new URL(u).searchParams.get('redirect_uri')!).port);
        o.onUrl?.(u);
        resolveUrl(u);
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      cwd: dir,
      waitMs: o.waitMs,
    });
  const defaultOutput = join(dir, `studyai-connection-${request.pairingId.slice(0, 8)}.json`);
  const callbackOf = async () => {
    const authorize = await url;
    return { authorize, back: fake.authorize(authorize), port: new URL(new URL(authorize).searchParams.get('redirect_uri')!).port };
  };
  const printed = () => [...out, ...err].join('\n');
  return { dir, fake, keys, request, requestPath, out, err, shown, start, url, callbackOf, defaultOutput, printed, createdAt, listening: () => listeningWhenShown };
}

const withState = (back: string, state: string) => {
  const u = new URL(back);
  u.searchParams.set('state', state);
  return u.toString();
};

describe('studyai-connect signs in locally and writes one sealed file', () => {
  it('listens before showing the address, takes the matching callback, and writes a 0600 file only the Site can open', async () => {
    const t = await setup();
    const run = t.start();
    const { authorize, back, port } = await t.callbackOf();
    expect(await t.listening()).toBe(true);
    const q = new URL(authorize).searchParams;
    expect(q.get('client_id')).toBe('dynamic_agent_client');
    expect(q.get('ext_agent_host_id')).toBe(t.request.hostId);
    expect(q.get('nonce')).toBe(t.request.nonce);
    expect(q.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/auth/callback`);
    expect(q.get('state')).not.toBe(t.request.nonce);
    expect(q.get('prompt')).toBeNull();

    const page = await get(back);
    expect(page.status).toBe(200);
    expect(page.body).toContain('연결 파일을 만들었습니다');
    expect(await run).toBe(0);
    expect(await accepting(port)).toBe(false);

    expect(readdirSync(t.dir).sort()).toEqual([`studyai-connection-${t.request.pairingId.slice(0, 8)}.json`, 'studyai-pairing.json'].sort());
    expect(statSync(t.defaultOutput).mode & 0o777).toBe(0o600);
    const text = readFileSync(t.defaultOutput, 'utf8');
    const sealed = parseSealedConnection(text);
    expect(sealed).not.toBeNull();
    const payload = await openConnection({ pairingId: t.request.pairingId, hostId: t.request.hostId }, t.keys.privateJwk, sealed!);
    expect(payload).not.toBeNull();
    expect(payload!.clientId).toMatch(/^oaiapp_fake/);
    expect(t.fake.refreshTokenState(payload!.refreshToken)).toBe('live');
    expect(payload!.expiresInS).toBeGreaterThan(3590);
    expect(payload!.expiresInS).toBeLessThanOrEqual(3600);
    expect(payload!.scopes).toContain('chatgpt.tokens.use.direct');

    const dir = new OpenAiDirectory({ http: t.fake.fetch as OutboundFetch, now: () => Date.now() + 20 * 60_000 });
    const verified = await dir.verifyTransferredIdToken(payload!.idToken, { clientId: payload!.clientId, nonce: t.request.nonce, issuedWithin: [t.createdAt - 60_000, t.request.expiresAt] });
    expect(verified).toMatchObject({ ok: true, identity: { subject: 'user-fake-1' } });

    const code = new URL(back).searchParams.get('code')!;
    for (const secret of [...t.fake.issued(), code, payload!.idToken]) {
      expect(text).not.toContain(secret);
      expect(t.printed()).not.toContain(secret);
      expect(page.body).not.toContain(secret);
    }
    expect(t.printed()).not.toContain('code=');
    expect(t.printed()).toContain('직접 내려받은 파일');
    expect(t.fake.count('refresh')).toBe(0);
    expect(t.fake.count('revoke')).toBe(0);
    expect(t.fake.count('exchange')).toBe(1);
  });

  it('ignores a wrong state, path, Host, method and an oversized or malformed request, then accepts the right one exactly once', async () => {
    const t = await setup();
    const run = t.start();
    const { back, port } = await t.callbackOf();
    const base = `http://127.0.0.1:${port}`;
    const state = new URL(back).searchParams.get('state')!;

    expect((await get(withState(back, 'forged-state'))).status).toBe(400);
    expect((await get(withState(back, state.slice(0, -1)))).status).toBe(400);
    expect((await get(back.replace('/auth/callback', '/auth/other'))).status).toBe(404);
    expect((await get(back, { host: `localhost:${port}` })).status).toBe(400);
    expect((await get(back, { host: 'attacker.example' })).status).toBe(400);
    expect((await get(back, { method: 'POST' })).status).toBe(400);
    expect((await get(`${back}&pad=${'x'.repeat(20_000)}`)).status).toBe(431);
    expect((await get(`${base}/auth/callback?state=${encodeURIComponent(state)}`)).status).toBe(400);
    expect((await get(`${base}/auth/callback?state=${encodeURIComponent(state)}&state=${encodeURIComponent(state)}&code=c`)).status).toBe(400);
    expect(t.fake.count('exchange')).toBe(0);

    const held = t.fake.hold('exchange');
    const first = get(back);
    await held.reached;
    const replay = await get(back);
    expect(replay.status).toBe(409);
    held.release();
    expect((await first).status).toBe(200);
    expect(await run).toBe(0);
    expect(t.fake.count('exchange')).toBe(1);
    expect(await accepting(port)).toBe(false);
    await expect(get(back)).rejects.toThrow();
    for (const line of t.printed().split('\n')) expect(line).not.toContain('forged-state');
  });

  it('stops waiting at the deadline, closes the listener, and writes nothing', async () => {
    const t = await setup({ waitMs: 300 });
    const run = t.start();
    const { port } = await t.callbackOf();
    expect(await run).toBe(1);
    expect(t.err.join('\n')).toContain('제한 시간');
    expect(await accepting(port)).toBe(false);
    expect(readdirSync(t.dir)).toEqual(['studyai-pairing.json']);
    expect(t.fake.count('exchange')).toBe(0);
  });

  it('refuses an expired or nearly expired request before listening', async () => {
    for (const expiresInMs of [-1_000, 30_000]) {
      const t = await setup({ expiresInMs });
      expect(await t.start()).toBe(1);
      expect(t.shown).toEqual([]);
      expect(t.err.join('\n')).toContain('만료');
    }
  });

  it('writes to --output when given, and reports cancelled consent without writing', async () => {
    const t = await setup({ args: ['--output', 'mine.json'] });
    const run = t.start();
    const { back } = await t.callbackOf();
    expect((await get(back)).status).toBe(200);
    expect(await run).toBe(0);
    expect(statSync(join(t.dir, 'mine.json')).mode & 0o777).toBe(0o600);

    const d = await setup();
    const denied = d.start();
    const { authorize, port } = await d.callbackOf();
    const state = new URL(authorize).searchParams.get('state')!;
    expect((await get(`http://127.0.0.1:${port}/auth/callback?error=access_denied&error_description=leaky%20text&state=${encodeURIComponent(state)}`)).status).toBe(200);
    expect(await denied).toBe(1);
    expect(d.err.join('\n')).toContain('취소');
    expect(d.printed()).not.toContain('leaky');
    expect(existsSync(d.defaultOutput)).toBe(false);
  });

  it('reports an unreachable token endpoint without writing a file', async () => {
    const t = await setup();
    t.fake.behaviour.nextExchange = 'transient';
    const run = t.start();
    const { back } = await t.callbackOf();
    expect((await get(back)).body).toContain('연결하지 못했습니다');
    expect(await run).toBe(1);
    expect(existsSync(t.defaultOutput)).toBe(false);
  });
});

describe('bad input is refused before any sign-in starts', () => {
  it('refuses usage errors, remote addresses, unreadable, malformed and unsafe request files, and an existing output', async () => {
    const t = await setup();
    const code = async (argv: string[]) => {
      t.out.length = 0;
      t.err.length = 0;
      return t.start(argv);
    };
    expect(await code([])).toBe(2);
    expect(await code([t.requestPath, t.requestPath])).toBe(2);
    expect(await code([t.requestPath, '--force'])).toBe(2);
    expect(await code([t.requestPath, '--output'])).toBe(2);
    expect(await code(['https://my-site.example/api/chatgpt/pairing'])).toBe(2);
    expect(t.err.join('\n')).toContain('인터넷 주소');
    expect(await code(['file:///etc/passwd'])).toBe(2);
    expect(await code([join(t.dir, 'nope.json')])).toBe(1);

    const write = (name: string, text: string) => {
      writeFileSync(join(t.dir, name), text);
      return join(t.dir, name);
    };
    const req = JSON.parse(readFileSync(t.requestPath, 'utf8')) as Record<string, unknown>;
    expect(await code([write('broken.json', '{"v":')])).toBe(1);
    expect(await code([write('private.json', JSON.stringify({ ...req, publicKey: t.keys.privateJwk }))])).toBe(1);
    expect(await code([write('origin.json', JSON.stringify({ ...req, siteOrigin: 'https://elsewhere.example' }))])).toBe(1);
    const pk = t.keys.publicJwk as { x: string; y: string };
    expect(await code([write('offcurve.json', JSON.stringify({ ...req, publicKey: { ...t.keys.publicJwk, y: pk.x } }))])).toBe(1);
    expect(await code([write('huge.json', JSON.stringify(req) + ' '.repeat(70 * 1024))])).toBe(1);
    expect(t.err.join('\n')).toContain('요청 파일');

    writeFileSync(t.defaultOutput, 'keep me');
    expect(await code([t.requestPath])).toBe(1);
    expect(readFileSync(t.defaultOutput, 'utf8')).toBe('keep me');
    expect(await code([t.requestPath, '--output', join(t.dir, 'missing-dir', 'x.json')])).toBe(1);

    expect(t.shown).toEqual([]);
    expect(t.fake.log).toEqual([]);
  });
});

describe('a token that is not handed over is revoked only when no sibling session can exist', () => {
  const issued = (): Client => ({ kind: 'issued', clientId: parseIssuedClientId('oaiapp_returning')!, loginHint: 'student@example.test' });

  it('a declined plan on a new registration writes nothing and revokes the orphan', async () => {
    const t = await setup();
    t.fake.behaviour.grantPlan = false;
    const run = t.start();
    const { back } = await t.callbackOf();
    await get(back);
    expect(await run).toBe(1);
    expect(t.err.join('\n')).toContain('플랜 사용이 허용되지 않았습니다');
    expect(existsSync(t.defaultOutput)).toBe(false);
    expect(t.fake.count('revoke')).toBe(1);
  });

  it('a returning client signs in with its id and login hint, and a declined plan revokes nothing', async () => {
    const ok = await setup({ client: issued() });
    const run = ok.start();
    const { authorize, back } = await ok.callbackOf();
    expect(new URL(authorize).searchParams.get('client_id')).toBe('oaiapp_returning');
    expect(new URL(authorize).searchParams.get('login_hint')).toBe('student@example.test');
    await get(back);
    expect(await run).toBe(0);
    const payload = await openConnection({ pairingId: ok.request.pairingId, hostId: ok.request.hostId }, ok.keys.privateJwk, parseSealedConnection(readFileSync(ok.defaultOutput, 'utf8'))!);
    expect(payload?.clientId).toBe('oaiapp_returning');

    const declined = await setup({ client: issued() });
    declined.fake.behaviour.grantPlan = false;
    const run2 = declined.start();
    await get((await declined.callbackOf()).back);
    expect(await run2).toBe(1);
    expect(declined.fake.count('revoke')).toBe(0);
  });

  it('never overwrites a file that appears during sign-in; drops a returning client token, revokes a new one', async () => {
    for (const [client, revokes] of [[issued(), 0], [{ kind: 'dynamic' } as Client, 1]] as const) {
      let output = '';
      const t = await setup({ client, onUrl: () => writeFileSync(output, 'someone else') });
      output = t.defaultOutput;
      const run = t.start();
      const { back } = await t.callbackOf();
      expect((await get(back)).body).toContain('연결하지 못했습니다');
      expect(await run).toBe(1);
      expect(readFileSync(t.defaultOutput, 'utf8')).toBe('someone else');
      expect(t.err.join('\n')).toContain('덮어쓰지 않습니다');
      expect(t.fake.count('revoke')).toBe(revokes);
      const issuedRefresh = t.fake.issued().filter((x) => x.startsWith('fake-rt-'));
      expect(issuedRefresh.map((x) => t.fake.refreshTokenState(x))).toEqual([revokes ? 'revoked' : 'live']);
    }
  });
});
