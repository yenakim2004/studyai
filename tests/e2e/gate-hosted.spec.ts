import { expect, test } from '@playwright/test';
import { ORIGINS } from './ports';
import { trackRequests, watchProblems } from './helpers';

/**
 * A hosted copy: the PRODUCTION entry and wrangler.jsonc in workerd with no variables at all (scripts/e2e-worker-server.mjs
 * gate), as a deployment would be. It must serve the study app to anyone, need no key, and never expose an AI route or the
 * ChatGPT account. The project keeps its historical name ("gate") because playwright.config.ts starts it under that name.
 */
const ORIGIN = ORIGINS.gate;
const HOST = new URL(ORIGIN).host;

test('the static app is served to anyone, with no sign-in page and no key', async ({ request }) => {
  for (const path of ['/', '/settings', '/course/anything']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    const body = await r.text();
    expect(body, path).toContain('<div id="root"');
    expect(body, path).not.toMatch(/owner key|소유자 키|Private site/i);
  }
  expect(await (await request.get('/api/health')).json()).toEqual({ service: 'studyai', ok: true });
});

test('every AI route refuses in Korean, even when asked exactly like the local app would', async ({ request }) => {
  const asLocal = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  const task = { task: 'tutor', mode: 'explain', question: 'x', excerpts: [{ ref: 'S1', lectureTitle: 'L', slide: 1, title: 'T', text: 'x' }], history: [] };
  for (const r of [
    await request.get('/api/status', { headers: asLocal }),
    await request.get('/api/chatgpt/models', { headers: asLocal }),
    await request.post('/api/ai/ask', { headers: asLocal, data: task }),
    await request.post('/api/chatgpt/start', { headers: asLocal, data: {} }),
    await request.post('/api/chatgpt/disconnect', { headers: asLocal, data: {} }),
  ]) {
    expect(r.status(), r.url()).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, code: 'local-only', message: expect.stringMatching(/pnpm local/) });
  }
  expect((await request.get(`/auth/callback?state=s&code=c`)).status()).toBe(404);
  for (const gone of ['/api/auth/session', '/api/owner/status']) expect((await request.get(gone)).status(), gone).toBe(404);
  expect(HOST).toMatch(/^127\.0\.0\.1:/);
});

test('the app opens and Settings says AI is not available here without calling anyone else', async ({ page }) => {
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await page.goto('/settings');
  await expect(page.getByText('이 사본에는 AI가 없습니다')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ChatGPT로 계속하기' })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  expect(problems.filter((p) => !/status of 404 /.test(p))).toEqual([]);
});
