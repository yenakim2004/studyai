import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { ORIGINS, PORTS } from './ports';

/**
 * Connecting the ChatGPT plan through the fake issuer (tests/helpers/fake-openai.mjs, served by scripts/e2e-worker-server.mjs).
 * There is no StudyAI key or login: the app at the loopback address talks to its own API directly.
 */
export const ORIGIN = ORIGINS.worker;
export const STUB = `http://127.0.0.1:${PORTS.stub}`;

/** Forgets the ChatGPT account, so a test starts disconnected. A test-entry route; production has none. */
export async function resetChatGpt(request: APIRequestContext): Promise<void> {
  expect((await request.post('/api/test/reset-chatgpt')).status()).toBe(200);
}

export async function connected(request: APIRequestContext): Promise<boolean> {
  const status = (await (await request.get('/api/status')).json()) as { connection: { kind: string } };
  return status.connection.kind === 'connected';
}

/** Settings → AI → "ChatGPT로 계속하기", consent at the fake issuer, back to Settings. Skipped when already connected. */
export async function connectChatGpt(page: Page): Promise<void> {
  if (await connected(page.request)) return;
  await page.goto('/settings');
  await page.getByRole('button', { name: 'ChatGPT로 계속하기' }).click();
  await page.waitForURL(`http://localhost:${PORTS.stub}/oai-auth/api/accounts/authorize?**`);
  await page.getByRole('link', { name: 'Allow StudyAI' }).click();
  await page.waitForURL(`${ORIGIN}/auth/callback?**`);
  await expect(page.getByRole('heading', { name: 'ChatGPT 연결 완료' })).toBeVisible();
  await page.getByRole('link', { name: 'StudyAI 설정으로 돌아가기' }).click();
  await page.waitForURL(`${ORIGIN}/settings`);
  await expect(page.getByText('사용 가능', { exact: true })).toBeVisible();
}

/** Connects without a browser page, for API-level tests: the same redirects a browser would follow. */
export async function connectByApi(request: APIRequestContext): Promise<void> {
  const start = (await (await request.post('/api/chatgpt/start', { headers: { origin: ORIGIN }, data: {} })).json()) as { ok: boolean; authorizeUrl: string };
  expect(start.ok).toBe(true);
  const consent = await request.get(start.authorizeUrl);
  const callback = /href="([^"]+)"/.exec(await consent.text())?.[1]?.replace(/&amp;/g, '&');
  expect(callback).toMatch(new RegExp(`^${ORIGIN}/auth/callback\\?`));
  const page = await request.get(callback!);
  expect(await page.text()).toContain('ChatGPT 연결 완료');
}
