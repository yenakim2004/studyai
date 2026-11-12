import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { META_CSP } from '../../config/headers';
import { DEMO_PATH, ORIGINS } from './ports';
import { revealWithKeyboard, tab, trackRequests, watchProblems } from './helpers';

/**
 * The static public demo (`vite build --mode demo`, docs/DEMO.md), served under /studyai/ with NO response headers, as GitHub
 * Pages serves it: the policy that protects it is the one in the page.
 */
const SAMPLE = '비행선 항법(가상의 데모 과목)';
const banner = (page: Page) => page.getByRole('region', { name: '이 데모에 대해' });

async function loadSample(page: Page): Promise<void> {
  await page.goto('./');
  await banner(page).getByRole('button', { name: '예시 과목 불러오기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE })).toBeVisible();
}

test('the banner says what the demo is, and the policy inside the page is what is enforced', async ({ page, request }) => {
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const res = await page.goto('./');
  // No header carries a policy here (GitHub Pages sends none): only the <meta> can be what blocks the probes below.
  expect(res!.headers()['content-security-policy']).toBeUndefined();
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', META_CSP);
  expect(META_CSP).toContain("connect-src 'self'");
  expect(META_CSP).toContain("script-src 'self'");
  expect(META_CSP).not.toContain("'unsafe-eval'");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');

  await expect(page).toHaveTitle('StudyAI 체험판');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  const note = banner(page);
  await expect(note).toContainText('데모.');
  await expect(note).toContainText('예시 내용은 지어낸 것입니다.');
  await expect(note).toContainText('이 브라우저에만 남고 업로드되지 않습니다');
  await expect(note).toContainText('데모에서는 AI 기능을 쓸 수 없습니다.');
  await expect(note.getByRole('button', { name: '예시 과목 불러오기' })).toBeVisible();
  violations.length = 0; // the page itself loaded cleanly; now probe the policy

  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.head.appendChild(s);
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(ran).toBe(false);
  expect(await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => true).catch(() => false))).toBe(false);
  expect(errors).toEqual([]);

  // GitHub Pages answers an unknown path with 404.html: it must be the app, so a reload on a deep link still opens it.
  const index = await (await request.get('./')).text();
  expect(await (await request.get('./404.html')).text()).toBe(index);
});

test('one click loads the sample course: slides beside text, search, flashcards and a practice exam', async ({ page }) => {
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await loadSample(page);

  // --- the course ------------------------------------------------------------------
  await expect(page.getByRole('link', { name: '1강 - 하늘 지도 읽기' })).toBeVisible();
  await expect(page.getByRole('link', { name: '2강 - 공중 추측 항법' })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: '예시 과목 열기' })).toBeVisible();

  // --- reading: the slide beside the text the app extracted ----------------------------
  await page.getByRole('link', { name: '2강 - 공중 추측 항법' }).click();
  await expect(page.getByText('슬라이드 1/7')).toBeVisible();
  for (const n of [2, 3, 4]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(`슬라이드 ${n}/7`)).toBeVisible();
  }
  const content = page.getByRole('tabpanel');
  await expect(content.getByText('맞바람은 그 속도만큼 대기 속도에서 빠집니다')).toBeVisible();
  await expect(content.locator('.katex').first()).toBeVisible(); // the formula is drawn
  await expect(page.locator('section[aria-label="슬라이드"] .slide-stage')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(content.getByText('PLOT-LEG(start, heading, ground_speed, hours)')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(content.getByRole('table')).toBeVisible();

  // --- search --------------------------------------------------------------------------
  await page.getByLabel('모든 강의 검색').first().fill('계류탑');
  await page.getByLabel('모든 강의 검색').first().press('Enter');
  await expect(page).toHaveURL(new RegExp(`/studyai/search\\?q=${encodeURIComponent('계류탑')}`));
  const hit = page.getByRole('link', { name: /지도 기호/ });
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark')).toContainText(/계류탑/);
  await hit.click();
  await expect(page.getByText('슬라이드 4/7')).toBeVisible();

  // --- flashcards: approved from the start, sources already checked ----------------------
  await page.getByRole('navigation', { name: '이동 경로' }).getByRole('link').first().click();
  await tab(page, /플래시카드/).click();
  await expect(page.getByText(/카드 13장 준비됨/)).toBeVisible();
  await page.getByRole('link', { name: '복습 시작' }).click();
  await expect(page.getByRole('button', { name: '답 보기' })).toBeVisible();
  await revealWithKeyboard(page);
  await expect(page.getByText('출처 확인됨')).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: '답 보기' }).or(page.getByRole('heading', { name: '복습을 마쳤습니다' }))).toBeVisible();

  // --- notes: markdown with a drawn formula (KaTeX runs under the policy in the page) ---------------
  await page.goto('./');
  await page.getByRole('link', { name: SAMPLE }).first().click();
  await tab(page, '노트').click();
  await page.getByRole('link', { name: /1강 요약/ }).click();
  await expect(page.getByText('가져온 학습 팩')).toHaveCount(2);
  await expect(page.locator('.katex').first()).toBeVisible();

  // --- a practice exam from the sample questions ------------------------------------------
  await page.goto('./');
  await page.getByRole('link', { name: SAMPLE }).first().click();
  await tab(page, '연습과 시험').click();
  await expect(page.getByText('문제 은행에 승인한 문제가 8개 있습니다.')).toBeVisible();
  await page.getByRole('button', { name: '시험 만들기' }).click();
  const builder = page.getByRole('dialog', { name: '모의시험 만들기' });
  await expect(builder.getByText(/승인된 문제 8개가 맞고/)).toBeVisible();
  await builder.getByRole('button', { name: '시험 시작' }).click();
  await expect(page.getByText(/^\d+문제 중 0문제 답함$/)).toBeVisible();
  const main = page.getByRole('main', { name: '문제' });
  await expect(main).toBeVisible();
  await page.getByRole('button', { name: '제출' }).first().click();
  const confirm = page.getByRole('dialog', { name: '시험을 제출할까요?' });
  await confirm.getByRole('button', { name: '지금 제출' }).click();
  await expect(page).toHaveURL(/\/results$/);

  expect(problems, 'console errors / CSP violations').toEqual([]);
  const origin = ORIGINS.demo;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')), 'only this site, blob and data URLs').toEqual([]);
  expect(requests.filter((u) => u.startsWith(origin) && !new URL(u).pathname.startsWith(DEMO_PATH)), 'everything is under the sub-path').toEqual([]);
  expect(requests.filter((u) => u.includes('/api/')), 'the demo never calls an API').toEqual([]);
});

test('the AI tutor is absent everywhere and nothing is sent', async ({ page }) => {
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await loadSample(page);

  await tab(page, 'AI 튜터').click();
  await expect(page.getByText('여기에는 AI가 없습니다')).toBeVisible();
  await expect(page.getByText('이 앱 사본에서는 AI를 쓸 수 없습니다.')).toBeVisible();
  await page.getByLabel('내 질문').fill('추측 항법이란 무엇인가요?');
  await expect(page.getByRole('button', { name: /보내기$/ })).toBeDisabled();

  await page.getByRole('button', { name: '학습 팩 만들기와 가져오기' }).click();
  await page.getByRole('menuitem', { name: 'AI 학습 자료 생성…' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI로 학습 자료 만들기' });
  await expect(dialog.getByText('이 앱 사본에서는 AI를 쓸 수 없습니다.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '만들고 확인하기' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: '설정과 백업' }).first().click();
  await expect(page.getByText('이 사본에는 AI가 없습니다')).toBeVisible();
  await expect(page.getByText(/AI 서버가 없어서 아무것도 다른 곳으로 보내지 않습니다/)).toBeVisible();
  await expect(page.getByLabel(/owner key/i)).toHaveCount(0); // no sign-in form for a server that does not exist

  expect(requests.filter((u) => u.includes('/api/') || !u.startsWith(ORIGINS.demo) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  expect(problems).toEqual([]);
});

test('the shipped demo files hold no AI client, no provider host and no key', async ({ request }) => {
  const files = readdirSync('dist-demo/assets').filter((f) => /\.(js|css)$/.test(f));
  expect(files.length).toBeGreaterThan(10);
  const bad = /api\.anthropic\.com|x-api-key|sk-ant-|ANTHROPIC_API_KEY|anthropic-version|generativelanguage\.googleapis\.com|x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY|\/api\/(?:health|status|chatgpt|auth|owner|ai)/;
  for (const f of files) {
    const body = await (await request.get(`assets/${f}`)).text();
    expect(bad.test(body), `${f} must not contain an AI client, a provider host or key material`).toBe(false);
  }
  expect(bad.test(await (await request.get('./')).text())).toBe(false);
});

test('the sample course survives a reload and is opened, not copied, by a second press', async ({ page }) => {
  await loadSample(page);
  const course = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE })).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('link', { name: SAMPLE }).first()).toBeVisible();
  await banner(page).getByRole('button', { name: '예시 과목 열기' }).click();
  await expect(page).toHaveURL(course);
  await expect(page.getByRole('navigation', { name: '과목' }).getByRole('listitem')).toHaveCount(1);
});

test('the banner and the sample course fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadSample(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('./');
  await expect(banner(page).getByRole('button', { name: '예시 과목 열기' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the demo banner and the sample course pass the accessibility audit (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const audit = async (label: string) => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect(bad, `${label}\n${bad.join('\n')}`).toEqual([]);
    };
    await page.goto('./');
    await expect(banner(page)).toBeVisible();
    await audit('dashboard with the demo banner');
    await loadSample(page);
    await audit('the sample course');
  });
}
