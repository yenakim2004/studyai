import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PNG_1X1, bodySp, buildPptx, para, picture, titleSp } from '../fixtures/pptx-builder';
import { createCourse, importFiles, watchProblems } from './helpers';

/**
 * A diagram's words are not in the file as text. The student can type them in; they become study text marked as typed by
 * the student, settle the "may hold text" warning, are searchable, and survive a reload. Synthetic deck only.
 */
const deck = () =>
  Buffer.from(
    buildPptx({
      slides: [
        {
          shapes: titleSp(2, 'Memory layout') + bodySp(3, [para('Two regions are shown', { bullet: 'char' })]) + picture(4, 'rIdImg1', 4500000, 1800000, 3800000, 3600000),
          rels: { rIdImg1: ['image', '../media/image1.png'] },
          parts: { 'ppt/media/image1.png': PNG_1X1 },
        },
      ],
    }),
  );

test('type the words of a picture: marked as typed, searchable, report updated, saved across reload', async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await createCourse(page, 'Pictures', 'PIC1');
  await importFiles(page, [{ name: 'Diagram lecture.pptx', buffer: deck() }]);
  await expect(page.getByText(/가져옴: 슬라이드 1장/)).toBeVisible();
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;

  // the report says plainly that the picture may hold words that were not read
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/텍스트나 도식이 들어 있을 수 있는 그림\(자동으로 읽지 않음\)/)).toBeVisible();

  await page.goto(`/lecture/${id}?slide=1`);
  const box = page.getByLabel('이 그림 속 글자');
  await expect(box).toBeVisible();
  await expect(page.getByRole('button', { name: '텍스트 저장' })).toBeDisabled(); // nothing typed yet
  await box.fill('high address\nstack\nuninitialized data (bss)\nlow address');
  await page.getByRole('button', { name: '텍스트 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: '저장했습니다.' })).toBeVisible();

  // the viewer's checks and the report now treat the picture as dealt with
  await page.reload();
  await expect(page.getByLabel('이 그림 속 글자')).toHaveValue(/uninitialized data \(bss\)/);
  await expect(page.getByText(/추출하지 않은 텍스트, 도식, 스크린샷이 있을 수 있습니다/)).toHaveCount(0); // not repeated under the picture
  await expect(page.getByRole('tab', { name: '확인 사항' })).toBeVisible(); // and no count of open problems on the tab
  await page.getByRole('tab', { name: /확인 사항/ }).click();
  await expect(page.getByText(/이 슬라이드에 있는 그림의 글자를 직접 입력했습니다/)).toBeVisible();
  await expect(page.getByText(/해결됨, 그림의 글자를 입력했습니다/)).toBeVisible();
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/텍스트나 도식이 들어 있을 수 있는 그림/)).toHaveCount(0);
  await expect(page.getByText('신뢰할 수 있음').first()).toBeVisible();

  // the typed words are searchable, and only because the student typed them
  await page.getByLabel('모든 강의 검색').fill('bss');
  await page.getByLabel('모든 강의 검색').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=bss/);
  await expect(page.getByRole('link', { name: /Memory layout/ })).toBeVisible();

  // removing them brings the warning back
  await page.goto(`/lecture/${id}?slide=1`);
  await page.getByRole('button', { name: '지우기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '지웠습니다.' })).toBeVisible();
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/텍스트나 도식이 들어 있을 수 있는 그림/)).toBeVisible();
  expect(problems, 'console errors / CSP violations').toEqual([]);
});

test('the picture-text box has no WCAG A/AA violations', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Pictures', 'PIC2');
  await importFiles(page, [{ name: 'Diagram lecture.pptx', buffer: deck() }]);
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  await page.goto(`/lecture/${id}?slide=1`);
  await expect(page.getByLabel('이 그림 속 글자')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
