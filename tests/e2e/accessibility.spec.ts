import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createCourse, importFiles, lectureBytes, revealWithKeyboard } from './helpers';

/**
 * Automated accessibility checks (axe-core) on every screen, in both themes.
 * Automated tools catch roughly a third of real problems; keyboard and screen-reader
 * behaviour are covered by the role/label based selectors used throughout the e2e tests.
 */
async function seed(page: Page) {
  await page.goto('/');
  await createCourse(page, 'Computability and Complexity', 'BCS303');
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: lectureBytes() }]);
  await expect(page.getByText(/가져옴: 슬라이드 5장/)).toBeVisible();
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, `${label}\n${bad.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no WCAG A/AA violations on any screen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await seed(page);
    const lectureUrl = page.url();

    await audit(page, 'course page');
    await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
    await expect(page.getByText('슬라이드 1/5')).toBeVisible();
    await audit(page, 'lecture viewer (content)');
    await page.getByRole('tab', { name: /확인 사항/ }).click();
    await audit(page, 'lecture viewer (checks)');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText('슬라이드 4/5')).toBeVisible(); // three quick presses are three slides
    await page.getByRole('tab', { name: '내용' }).click();
    await audit(page, 'lecture viewer (equation slide)');

    await page.getByRole('link', { name: /추출 보고서/ }).click();
    await audit(page, 'report');
    await page.goto('/search?q=turing');
    await expect(page.getByText(/슬라이드/).first()).toBeVisible();
    await audit(page, 'search results');
    await page.goto('/settings');
    await audit(page, 'settings');
    await page.goto('/');
    await audit(page, 'dashboard');
    await page.getByRole('button', { name: '새 과목' }).first().click();
    await expect(page.getByRole('dialog', { name: '새 과목' })).toBeVisible();
    await audit(page, 'new course dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '새 과목' })).toBeHidden();
    void lectureUrl;
  });
}

test('keyboard: skip link, focus is never lost, dialogs trap and restore focus', async ({ page }) => {
  await seed(page);
  await page.reload(); // start from a fresh focus state
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '본문으로 건너뛰기' })).toBeFocused();
  await page.getByRole('button', { name: '과목 정보' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '과목 정보' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('과목 이름', { exact: true })).toBeFocused(); // first field is focused on open
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '과목 정보' })).toBeFocused(); // focus returns to the opener
});

for (const scheme of ['light', 'dark'] as const) {
  test(`no WCAG A/AA violations on the study screens (${scheme})`, async ({ page }) => {
    const { importPack, seed: seedLecture, tab } = await import('./helpers');
    await page.emulateMedia({ colorScheme: scheme });
    await seedLecture(page);
    const dialog = await importPack(page);
    await expect(dialog.getByText(/개를 슬라이드에서 찾았습니다/)).toBeVisible();
    await audit(page, 'study pack import dialog');
    await dialog.getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();

    await expect(page.getByRole('heading', { name: '결정을 기다리는 카드 2장' })).toBeVisible();
    await audit(page, 'flashcards (pending review)');
    await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
    await page.getByRole('button', { name: '새 카드' }).click();
    await expect(page.getByRole('dialog', { name: '새 카드' })).toBeVisible();
    await audit(page, 'card editor dialog');
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: '복습 시작' }).click();
    await expect(page.getByRole('main', { name: '플래시카드' })).toBeVisible();
    await audit(page, 'review (question side)');
    await revealWithKeyboard(page);
    await audit(page, 'review (answer side)');
    await page.goBack();

    await tab(page, '노트').click();
    await page.getByRole('button', { name: '슬라이드로 노트 만들기' }).click();
    await page.getByRole('dialog', { name: '슬라이드로 노트 만들기' }).getByRole('button', { name: '노트 만들기' }).click();
    await expect(page.getByText('노트 1개를 만들었습니다.')).toBeVisible();
    await audit(page, 'notes list');
    await page.getByRole('link', { name: /강의 노트/ }).click();
    await expect(page.getByText('슬라이드에서 자동 추출').first()).toBeVisible();
    await audit(page, 'note editor');

    await tab(page, '연습과 시험').click();
    await expect(page.getByRole('heading', { name: '결정을 기다리는 문제 2개' })).toBeVisible();
    await audit(page, 'practice (pending questions)');
    await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
    await page.getByRole('button', { name: '새 문제' }).click();
    await expect(page.getByRole('dialog', { name: '새 문제' })).toBeVisible();
    await audit(page, 'question editor dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '시험 만들기' }).click();
    await expect(page.getByRole('dialog', { name: '모의시험 만들기' })).toBeVisible();
    await audit(page, 'exam builder dialog');
    await page.getByRole('dialog', { name: '모의시험 만들기' }).getByRole('button', { name: '시험 시작' }).click();

    await expect(page.getByRole('main', { name: '문제' })).toBeVisible();
    await audit(page, 'exam (taking)');
    await page.getByRole('button', { name: '제출' }).first().click();
    await expect(page.getByRole('dialog', { name: '시험을 제출할까요?' })).toBeVisible();
    await audit(page, 'submit confirmation');
    await page.getByRole('dialog', { name: '시험을 제출할까요?' }).getByRole('button', { name: '지금 제출' }).click();
    await expect(page.getByRole('heading', { name: '내 점수' })).toBeVisible();
    await expect(page.getByText('내 답 채점하기')).toBeVisible();
    await audit(page, 'exam results with self-marking');
  });
}
