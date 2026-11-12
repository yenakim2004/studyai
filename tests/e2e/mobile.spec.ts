import { expect, test, type Page } from '@playwright/test';
import { createCourse, importFiles, lectureBytes } from './helpers';

/** Phone-sized checks (Pixel 7 emulation): nothing overflows horizontally and the core flow works by touch. */
async function noHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(overflow.scrollWidth, `${label}: page is wider than the screen`).toBeLessThanOrEqual(overflow.innerWidth);
}

test('@mobile import, read and search on a phone', async ({ page }, testInfo) => {
  await page.goto('/');
  await noHorizontalScroll(page, 'dashboard (empty)');
  await expect(page.getByRole('button', { name: '메뉴 열기' })).toBeVisible();

  await createCourse(page, 'Computability and Complexity', 'BCS303');
  await noHorizontalScroll(page, 'course (empty)');
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: lectureBytes() }]);
  await expect(page.getByText(/가져옴: 슬라이드 5장/)).toBeVisible();
  await noHorizontalScroll(page, 'course (with lecture)');
  await page.screenshot({ path: testInfo.outputPath('course-mobile.png'), fullPage: true });

  await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
  await expect(page.getByText('슬라이드 1/5')).toBeVisible();
  await noHorizontalScroll(page, 'lecture');
  await page.getByRole('button', { name: '다음 슬라이드(오른쪽 화살표)' }).tap();
  await expect(page.getByText('슬라이드 2/5')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByText('A tape that is infinite in both directions')).toBeVisible();
  // the horizontal filmstrip is available and usable
  await page.getByRole('button', { name: /^슬라이드 3:/ }).tap();
  await expect(page.getByText('슬라이드 3/5')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('lecture-mobile.png'), fullPage: true });

  // menu drawer
  await page.getByRole('button', { name: '메뉴 열기' }).tap();
  const menu = page.getByRole('dialog', { name: '메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByLabel('모든 강의 검색').fill('turing');
  await menu.getByLabel('모든 강의 검색').press('Enter');
  await expect(page).toHaveURL(/search\?q=turing/);
  await expect(page.getByRole('link', { name: /Turing Machines and Decidability/ }).first()).toBeVisible();
  await noHorizontalScroll(page, 'search');

  await page.goto('/settings');
  await noHorizontalScroll(page, 'settings');
  await page.goto('/');
  await noHorizontalScroll(page, 'dashboard');
});
