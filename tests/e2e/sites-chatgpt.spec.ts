import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { runConnect } from '../../src/cli/connect';
import { SECURITY_HEADERS } from '../../config/headers';
import { HostedChatGptAccount } from '../../worker/src/hosted/account';
import { toBase64Url } from '../../worker/src/encoding';
import { handleSiteApi } from '../../worker/src/sites/routes';
import { localD1 } from '../helpers/d1';
import { createFakeOpenAi } from '../helpers/fake-openai.mjs';

// Sites dispatch is simulated here; D1, the built UI, CLI listener and OAuth verification are real.
test('personal Site connects through files and keeps the private token out of browser traffic', async ({ page }) => {
  const d1 = await localD1();
  const dir = await mkdtemp(join(tmpdir(), 'studyai-site-ui-'));
  const fake = createFakeOpenAi();
  const pending: Promise<unknown>[] = [];
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  let origin = '';
  let server: Server | undefined;
  const root = resolve('dist/client');
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  const bodies: Promise<string>[] = [];
  page.on('response', response => { if (response.url().includes('/api/')) bodies.push(response.text()); });
  try {
    server = createServer((req, res) => {
      void (async () => {
        const path = new URL(req.url ?? '/', origin).pathname;
        if (path.startsWith('/api/')) {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && !name.startsWith('oai-authenticated-')) headers.set(name, value);
          headers.set('oai-authenticated-user-id', 'site-owner');
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          const request = new Request(origin + path, { method: req.method, headers, ...(req.method === 'POST' ? { body } : {}) });
          const response = await handleSiteApi(request, origin, () => new HostedChatGptAccount({ db: d1.db, sealKey: key, http: fake.fetch, now: Date.now, defer: p => { pending.push(p); }, limits: { revokeDelaysMs: [0] } }));
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        const file = resolve(root, '.' + path);
        if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
        let data: Buffer;
        let extension = extname(file);
        try { data = await readFile(file); }
        catch { data = await readFile(join(root, 'index.html')); extension = '.html'; }
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime[extension] ?? 'application/octet-stream' });
        res.end(data);
      })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin + '/settings');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ChatGPT 연결 요청 파일 받기' }).click();
    await (await download).saveAs(join(dir, 'pairing.json'));
    await expect(page.getByText('연결 파일을 기다리는 중', { exact: false })).toBeVisible();
    await page.getByLabel('암호화된 연결 결과 파일').setInputFiles(join(dir, 'pairing.json'));
    await expect(page.getByRole('alert')).toContainText('요청 파일은 올릴 수 없습니다');
    let callback: Promise<Response> | undefined;
    const result = await runConnect(['pairing.json', '--output', 'connection.json'], { cwd: dir, now: Date.now, http: fake.fetch, waitMs: 10_000, out: () => {}, err: () => {}, presentAuthorizeUrl: url => { callback = fetch(fake.authorize(url)); } });
    expect(result).toBe(0);
    expect((await callback)?.status).toBe(200);
    await page.getByLabel('암호화된 연결 결과 파일').setInputFiles(join(dir, 'connection.json'));
    await expect(page.getByText('연결된 계정: student@example.test')).toBeVisible();
    await page.getByLabel('ChatGPT 모델').selectOption('gpt-fake-small');
    await expect(page.getByText('Fake Small', { exact: true }).first()).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ChatGPT 연결 요청 파일 받기' })).toBeVisible();
    expect((await Promise.all(bodies)).join('\n')).not.toMatch(/fake-at|fake-rt|accessToken|refreshToken|idToken/);
    expect(problems).toEqual([]);
  } finally {
    await Promise.allSettled(pending);
    if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
    await d1.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
