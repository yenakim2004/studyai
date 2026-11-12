import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { createCourse, PPTX_MIME, revealWithKeyboard, tab, watchProblems } from './helpers';

/**
 * Optional: run the whole chain on YOUR real material.
 *   STUDYAI_REAL_LECTURE=C:\path\lecture.pptx  STUDYAI_REAL_PACK=C:\path\pack.json  pnpm test:e2e real-data
 * The pack should already pass `node dist-cli/lecture-cli.mjs validate` (see the lecture-pack skill).
 * Skipped when the variables are not set. Nothing from these files is stored in the repository.
 */
const lecture = process.env['STUDYAI_REAL_LECTURE'];
const pack = process.env['STUDYAI_REAL_PACK'];

test.describe('real lecture and pack', () => {
  test.skip(!lecture || !pack, 'set STUDYAI_REAL_LECTURE and STUDYAI_REAL_PACK to run');

  test('import, read, import the pack, verify quotes, approve and study', async ({ page }, testInfo) => {
    const problems = watchProblems(page);
    await page.goto('/');
    await createCourse(page, 'Real course');
    await page.locator('input[aria-label="강의 파일 선택"]').setInputFiles({ name: basename(lecture!), mimeType: PPTX_MIME, buffer: readFileSync(lecture!) });
    await expect(page.getByText(/가져옴: 슬라이드 \d+장/)).toBeVisible({ timeout: 30_000 });
    const slides = Number(/가져옴: 슬라이드 (\d+)장/.exec((await page.getByText(/가져옴: 슬라이드 \d+장/).textContent()) ?? '')?.[1]);
    expect(slides).toBeGreaterThan(0);

    // read it
    await page.getByRole('link', { name: /열기|확인 필요/ }).first().click();
    await expect(page.getByText(new RegExp(`슬라이드 1/${slides}`))).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('section[aria-label="슬라이드"] .slide-stage')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('real-slide-2.png') });
    if ((await page.locator('section[aria-label="슬라이드"] .katex').count()) > 0) {
      await expect(page.locator('section[aria-label="추출한 내용"] .katex').first()).toBeVisible(); // equations render
    }

    // import the pack: every quote must be found on the real slides
    await page.getByRole('link', { name: 'Real course' }).first().click();
    await page.getByRole('button', { name: '학습 팩 만들기와 가져오기' }).click();
    await page.getByRole('menuitem', { name: '학습 팩 가져오기…' }).click();
    const dialog = page.getByRole('dialog', { name: '학습 팩 가져오기' });
    await dialog.getByLabel('팩 JSON').fill(readFileSync(pack!, 'utf8'));
    await dialog.getByRole('button', { name: '이 팩 확인' }).click();
    const sources = await dialog.getByText(/개를 슬라이드에서 찾았습니다/).textContent();
    const m = /(\d+) of (\d+) cited quotes/.exec(sources ?? '');
    expect(m, sources ?? '').not.toBeNull();
    expect(m![1], 'every cited quote should be verified').toBe(m![2]);
    await page.screenshot({ path: testInfo.outputPath('real-pack-import.png') });
    await dialog.getByRole('button', { name: /^검토할 항목 \d+개 가져오기$/ }).click();

    await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
    await page.getByRole('link', { name: '복습 시작' }).click();
    await expect(page.getByRole('button', { name: '답 보기' })).toBeVisible();
    await revealWithKeyboard(page);
    await page.screenshot({ path: testInfo.outputPath('real-card.png') });
    await page.keyboard.press('3');

    await page.goBack();
    await tab(page, '연습과 시험').click();
    await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
    await page.getByRole('button', { name: '시험 만들기' }).click();
    await page.getByRole('dialog', { name: '모의시험 만들기' }).getByRole('button', { name: '시험 시작' }).click();
    await expect(page.getByRole('main', { name: '문제' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('real-exam.png') });
    expect(problems, 'console errors / CSP violations').toEqual([]);
  });
});
