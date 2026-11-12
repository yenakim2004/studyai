import AxeBuilder from '@axe-core/playwright';
import { ORIGINS } from './ports';
import { expect, test, type Page } from '@playwright/test';
import { seed, tab, trackRequests, watchProblems } from './helpers';

/**
 * The app opened WITHOUT the AI server (plain static preview): every AI screen must say so, send nothing anywhere, and the
 * rest of the app must be untouched.
 */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, `${label}\n${bad.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`without an AI server every AI screen explains it and sends nothing (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const problems = watchProblems(page);
    const requests = trackRequests(page);
    await seed(page);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'AI 학습 도우미' })).toBeVisible();
    await expect(page.getByText('이 사본에는 AI가 없습니다')).toBeVisible();
    await expect(page.getByText(/AI 서버가 없어서 아무것도 다른 곳으로 보내지 않습니다/)).toBeVisible();
    await audit(page, 'settings (no server)');

    await page.goto('/');
    await page.getByRole('link', { name: /Computability/ }).first().click();
    await tab(page, 'AI 튜터').click();
    await expect(page.getByText('여기에는 AI가 없습니다')).toBeVisible();
    await page.getByLabel('내 질문').fill('What is a tape?');
    await expect(page.getByRole('button', { name: /보내기$/ })).toBeDisabled();
    await audit(page, 'tutor (no server)');

    await page.getByRole('button', { name: '학습 팩 만들기와 가져오기' }).click();
    await page.getByRole('menuitem', { name: 'AI 학습 자료 생성…' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI로 학습 자료 만들기' });
    await expect(dialog.getByText('이 앱 사본에서는 AI를 쓸 수 없습니다.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '만들고 확인하기' })).toBeDisabled();
    await audit(page, 'generate dialog (no server)');
    await page.keyboard.press('Escape');

    // the lecture viewer offers the tutor, and everything else there still works
    await tab(page, '강의').click();
    await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
    await expect(page.getByRole('link', { name: '튜터에게 묻기' })).toHaveAttribute('href', /\/tutor\?lecture=.*&slide=1/);
    await expect(page.getByText('슬라이드 1/5')).toBeVisible();

    // nothing but this site's own files was ever requested, and the only /api calls were the harmless availability check
    expect(requests.filter((u) => !u.startsWith(ORIGINS.preview) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(requests.filter((u) => u.includes('/api/')).every((u) => /\/api\/status$/.test(u))).toBe(true);
    expect(problems).toEqual([]);
  });
}
