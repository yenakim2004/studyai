import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { seed, tab, watchProblems } from './helpers';
import { ORIGIN, resetChatGpt, STUB } from './worker-connect';

/**
 * ChatGPT sign-in and the tutor on the plan, against the real local Worker and Durable Object in workerd. OpenAI is the
 * fake issuer in tests/helpers/fake-openai.mjs, served by scripts/e2e-worker-server.mjs: the browser meets it on
 * `localhost` (another site than the app on 127.0.0.1, as auth.openai.com is), and the Worker reaches it through the test
 * entry's address rewrite. ID tokens are RS256-signed by the fake and verified by the app. This proves the app's side of
 * the flow only. It is not a live OpenAI login. There is no StudyAI key or login before it.
 */
test.describe.configure({ mode: 'serial' });


async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, label + ': ' + bad.join(' ; ')).toEqual([]);
}

test.afterAll(async ({ request }) => {
  await request.post('/api/test/reset-chatgpt');
});

test('ChatGPT plan: sign in through the fake issuer, answer in the tutor with the plan label, disconnect', async ({ page, request }) => {
  await resetChatGpt(request);
  const problems = watchProblems(page);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'ChatGPT 플랜 연결' })).toBeVisible();
  await expect(page.getByText('StudyAI는 달러 비용을 계산하지 않습니다', { exact: false })).toBeVisible();
  await expect(page.getByText('꺼짐', { exact: true })).toBeVisible();
  // one engine, no StudyAI sign-in: no key box, no engine choice, no Gemini anywhere on the page
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toMatch(/Gemini|Google|owner key|소유자 키/i);
  expect((await page.context().cookies()).filter((c) => c.name.includes('studyai'))).toEqual([]);

  await page.getByRole('button', { name: 'ChatGPT로 계속하기' }).click();
  await page.waitForURL(`http://localhost:${PORTS.stub}/oai-auth/api/accounts/authorize?**`);
  await page.getByRole('link', { name: 'Allow StudyAI' }).click();
  await page.waitForURL(`${ORIGIN}/auth/callback?**`);
  await expect(page.getByRole('heading', { name: 'ChatGPT 연결 완료' })).toBeVisible();
  await audit(page, 'callback page');
  const callbackHtml = await page.content();
  expect(callbackHtml).not.toMatch(/code-|state=|oaiapp_/);
  await page.getByRole('link', { name: 'StudyAI 설정으로 돌아가기' }).click();
  await page.waitForURL(`${ORIGIN}/settings`);

  await expect(page.getByText('연결된 계정: student@example.test')).toBeVisible();
  await expect(page.getByText('사용 가능', { exact: true })).toBeVisible();
  const model = page.getByLabel('ChatGPT 모델');
  await expect(model.locator('option')).toHaveText(['모델을 고르세요', 'Fake Large', 'Fake Small']);
  await model.selectOption('gpt-fake-small');
  await expect(page.getByRole('region', { name: 'ChatGPT 플랜 연결' }).locator('span', { hasText: /^Fake Small$/ })).toBeVisible();
  await audit(page, 'settings: ChatGPT connected');

  const status = await page.request.get('/api/status');
  const statusText = await status.text();
  expect(JSON.parse(statusText)).toMatchObject({ state: 'ready', signInAvailable: true, connection: { kind: 'connected', email: 'student@example.test' } });
  expect(statusText).not.toMatch(/fake-(at|rt)-/);

  await seed(page);
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI 튜터').click();
  await page.getByLabel('내 질문').fill('What is a transition function?');
  await expect(page.getByText(/OpenAI \(내 ChatGPT 플랜\)/)).toBeVisible();
  await page.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).check();
  await page.getByRole('button', { name: /보내기$/ }).click();
  const answer = page.getByRole('listitem').filter({ hasText: 'A Turing machine reads and writes symbols on an infinite tape' });
  await expect(answer).toBeVisible();
  await expect(answer.getByText('ChatGPT 플랜 사용')).toBeVisible();
  await expect(answer).not.toContainText('$');

  const log = (await (await request.get(`${STUB}/__oai/log`)).json()) as { kind: string; agentNameHint?: string | null; hasIdTokenHint?: boolean; body?: { model: string; store: boolean; stream: boolean; keys: string[] } }[];
  expect(log.find((e) => e.kind === 'authorize')).toMatchObject({ agentNameHint: 'StudyAI', hasIdTokenHint: false });
  const sent = log.filter((e) => e.kind === 'responses').at(-1)!.body!;
  expect(sent).toEqual({ model: 'gpt-fake-small', store: false, stream: true, keys: ['input', 'instructions', 'model', 'store', 'stream'] });
  const revokesBefore = log.filter((e) => e.kind === 'revoke').length;

  await page.goto('/settings');
  await page.getByRole('button', { name: '연결 해제' }).click();
  await expect(page.getByText('ChatGPT 연결을 해제했습니다. OpenAI 쪽 로그인도 해지했습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ChatGPT로 계속하기' })).toBeVisible();
  const after = (await (await request.get(`${STUB}/__oai/log`)).json()) as { kind: string }[];
  expect(after.filter((e) => e.kind === 'revoke').length).toBe(revokesBefore + 1);

  const refused = await page.request.post('/api/ai/ask', { headers: { origin: ORIGIN }, data: { task: 'tutor', mode: 'explain', question: 'x', excerpts: [{ ref: 'S1', lectureTitle: 'L', slide: 1, title: 'T', text: 'x' }], history: [] } });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ ok: false, code: 'chatgpt-signin-required', message: expect.stringMatching(/[가-힣]/) });
  expect(problems.filter((p) => !/status of 403 /.test(p))).toEqual([]);
});
