import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AiReply } from '../src/core/tutor/contract';
import { runConnect } from '../src/cli/connect';
import { parsePairingRequest } from '../src/core/chatgpt/bridge';
import { HostedChatGptAccount } from '../worker/src/hosted/account';
import { toBase64Url } from '../worker/src/encoding';
import { handleSiteApi } from '../worker/src/sites/routes';
import { localD1 } from './helpers/d1';
import { createFakeOpenAi } from './helpers/fake-openai.mjs';

const ORIGIN = 'https://studyai.example.test';
let d1: Awaited<ReturnType<typeof localD1>>;
beforeAll(async () => { d1 = await localD1(); });
afterAll(async () => { await d1.dispose(); });

function request(path: string, body?: unknown, user: string | null = 'site-owner'): Request {
  return new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { 'oai-authenticated-user-id': user } : {}), origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it('refuses absent identity and cross-site requests before account construction', async () => {
  const never = (): never => { throw new Error('account must not be constructed'); };
  expect((await handleSiteApi(request('/api/status', undefined, null), ORIGIN, never)).status).toBe(401);
  const cross = request('/api/chatgpt/pairing', {});
  cross.headers.set('origin', 'https://another.example.test');
  expect((await handleSiteApi(cross, ORIGIN, never)).status).toBe(403);
  expect((await handleSiteApi(request('/api/status'), null, never)).status).toBe(503);
});

it('recovers abandoned ask slots even when their request never reaches finally', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const releases: ((reply: AiReply) => void)[] = [];
  const ok: AiReply = { ok: true, text: '응답', model: 'test' };
  let entered = 0;
  const unused = async (): Promise<never> => { throw new Error('unexpected account call'); };
  const account = () => ({ status: unused, createPairing: unused, install: unused, models: unused, selectModel: unused, resume: unused, disconnect: unused,
    ask: () => ++entered <= 2 ? new Promise<AiReply>(resolve => releases.push(resolve)) : Promise.resolve(ok),
  });
  const body = { task: 'tutor', mode: 'explain', question: '설명해 주세요.', excerpts: [{ ref: 'S1', lectureTitle: '강의', slide: 1, title: '제목', text: '자료' }], history: [] };
  const first = handleSiteApi(request('/api/ai/ask', body), ORIGIN, account);
  const second = handleSiteApi(request('/api/ai/ask', body), ORIGIN, account);
  try {
    await vi.waitFor(() => expect(entered).toBe(2));
    vi.setSystemTime(Date.now() + 181_000);
    const third = await handleSiteApi(request('/api/ai/ask', body), ORIGIN, account);
    expect(third.status).toBe(200);
  } finally {
    for (const release of releases) release(ok);
    await Promise.all([first, second]);
    vi.useRealTimers();
  }
});

it('downloads a pairing, signs in over the real CLI listener, installs ciphertext and answers through the authenticated API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studyai-sites-flow-'));
  const fake = createFakeOpenAi();
  const deferred: Promise<unknown>[] = [];
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  let responseGate: Promise<void> | null = null;
  let entered = 0;
  let twoEntered: () => void = () => {};
  let release: () => void = () => {};
  const make = () => new HostedChatGptAccount({ db: d1.db, sealKey: key, http: async (url, init) => {
    if (responseGate && url.endsWith('/responses')) { if (++entered === 2) twoEntered(); await responseGate; }
    return fake.fetch(url, init);
  }, now: Date.now, defer: p => { deferred.push(p); }, limits: { revokeDelaysMs: [0] } });
  const api = (path: string, body?: unknown, user?: string) => handleSiteApi(request(path, body, user), ORIGIN, make);
  try {
    const start = await api('/api/chatgpt/pairing', { account: 'current', forceConsent: false });
    expect(start.status).toBe(200);
    const download = await start.json();
    const pairing = parsePairingRequest(download.request);
    expect(pairing).not.toBeNull();
    if (!pairing) throw new Error('missing pairing');
    await writeFile(join(dir, 'pairing.json'), JSON.stringify(pairing));
    const wrongFile = await api('/api/chatgpt/install', pairing);
    expect(wrongFile.status).toBe(400);
    expect(await wrongFile.json()).toMatchObject({ outcome: 'file-invalid' });
    expect((await api('/api/chatgpt/install', { ct: 'x'.repeat(65_536) })).status).toBe(413);
    expect((await api('/api/chatgpt/pairing', { account: 'someone-else' })).status).toBe(400);
    let callback: Promise<Response> | undefined;
    const messages: string[] = [];
    const exit = await runConnect(['pairing.json', '--output', 'connection.json'], {
      cwd: dir, http: fake.fetch, now: Date.now,
      presentAuthorizeUrl: url => { callback = fetch(fake.authorize(url)); },
      out: line => messages.push(line), err: line => messages.push(line),
      waitMs: 10_000,
    });
    expect(exit, messages.join('\n')).toBe(0);
    expect((await callback)?.status).toBe(200);
    const file = await readFile(join(dir, 'connection.json'), 'utf8');
    expect(file).not.toMatch(/accessToken|refreshToken|idToken|fake-at|fake-rt/);
    const install = await api('/api/chatgpt/install', JSON.parse(file));
    expect(await install.json()).toMatchObject({ ok: true, outcome: 'connected' });
    const status = await api('/api/status');
    expect(await status.json()).toMatchObject({ state: 'ready', connectVia: 'file', connection: { kind: 'connected' } });
    expect((await api('/api/status', undefined, 'other-user')).status).toBe(403);
    const models = await api('/api/chatgpt/models');
    expect(await models.json()).toMatchObject({ ok: true, models: [{ slug: 'gpt-fake-large' }, { slug: 'gpt-fake-small' }] });
    expect((await api('/api/chatgpt/model', { model: 'gpt-fake-small' })).status).toBe(200);
    const task = { task: 'tutor', mode: 'explain', question: '설명해 주세요.', excerpts: [{ ref: 'S1', lectureTitle: '강의', slide: 1, title: '테이프', text: '테이프는 무한합니다.' }], history: [] };
    responseGate = new Promise<void>(r => { release = r; });
    const both = new Promise<void>(r => { twoEntered = r; });
    const first = api('/api/ai/ask', task);
    const second = api('/api/ai/ask', task);
    await both;
    expect((await api('/api/ai/ask', task)).status).toBe(429);
    release();
    for (const answer of await Promise.all([first, second])) expect(await answer.json()).toMatchObject({ ok: true, model: 'gpt-fake-small' });
    const replay = await api('/api/chatgpt/install', JSON.parse(file));
    expect(await replay.json()).toMatchObject({ ok: false, outcome: 'unknown-attempt' });
    expect((await api('/api/chatgpt/disconnect', { forget: true })).status).toBe(200);
    expect((await api('/api/status', undefined, 'other-user')).status).toBe(403);
    expect(await (await api('/api/status')).json()).toMatchObject({ connection: { kind: 'disconnected' } });
    expect(messages.join('\n')).not.toMatch(/fake-at|fake-rt|accessToken|refreshToken/);
  } finally {
    release();
    await Promise.allSettled(deferred);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
