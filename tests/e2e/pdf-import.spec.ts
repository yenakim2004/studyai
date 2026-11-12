import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createCourse, lectureBytes, trackRequests, watchProblems } from './helpers';

/**
 * PDF lectures in the real production build, under the production CSP: a text PDF is read, shown, searched and offered to
 * the tutor by page number; scanned pages are shown and marked as having no text; broken and password-protected files are
 * refused with a reason; PowerPoint import still works. Synthetic fixtures only (tests/fixtures/gen_pdf_fixtures.py).
 */

const PDF_DIR = fileURLToPath(new URL('../fixtures/pdf/', import.meta.url));
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: readFileSync(`${PDF_DIR}${name}`) });
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function choose(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[aria-label="강의 파일 선택"]').setInputFiles(files);
}

const queue = (page: Page) => page.locator('section[aria-labelledby="queue-h"]');

async function openLecture(page: Page, title: string): Promise<string> {
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.waitForURL(/\/lecture\/[^/?#]+/);
  return page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
}

/** The page image is drawn: a decoded bitmap with ink on it, not a broken or blank image. Returns the share of dark pixels. */
async function expectPageImage(page: Page): Promise<number> {
  const img = page.locator('.slide-stage img[src^="blob:"]').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 100)).toBe(true);
  const ink = await img.evaluate((el: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 300) dark++;
    return dark / (data.length / 4);
  });
  expect(ink, 'page image has visible content').toBeGreaterThan(0.002);
  return ink;
}

test('a text PDF becomes a lecture: pages shown, text read, searchable, cited by page for the tutor', async ({ page }) => {
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await page.goto('/');
  await createCourse(page, 'Operating systems', 'OS101');

  await choose(page, [pdf('text-lecture.pdf')]);
  await expect(page.getByText('가져옴: 3쪽')).toBeVisible({ timeout: 30_000 });
  await expect(queue(page).getByRole('link', { name: '확인 필요 1쪽' })).toBeVisible();
  const lectures = page.locator('section[aria-labelledby="lectures-h"]');
  await expect(lectures.getByText('PDF', { exact: true })).toBeVisible();
  await expect(lectures.getByText(/3쪽$/)).toBeVisible();

  const id = await openLecture(page, 'text-lecture');
  await expectPageImage(page);
  await expect(page.getByRole('tabpanel').getByText('선점형 스케줄링은 실행 중인 프로세스를 중단시킬 수 있다')).toBeVisible();

  await page.goto(`/lecture/${id}?slide=3`);
  await expectPageImage(page);
  await expect(page.getByText(/문자 인식\(OCR\)은 하지 않으므로/).first()).toBeVisible();

  await page.goto(`/search?q=${encodeURIComponent('순환 대기')}`);
  await expect(page.locator(`a[href="/lecture/${id}?slide=2"]`)).toBeVisible();

  const courseUrl = await page.evaluate(async (lectureId) => {
    const open = indexedDB.open('studyai');
    const db = await new Promise<IDBDatabase>((resolve) => (open.onsuccess = () => resolve(open.result)));
    const row = await new Promise<{ courseId: string }>((resolve) => {
      const req = db.transaction('lectures').objectStore('lectures').get(lectureId);
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return `/course/${row.courseId}`;
  }, id);
  await page.goto(`${courseUrl}/tutor?lecture=${id}&slide=2`);
  const sent = page.locator('details', { has: page.locator('pre') });
  await sent.locator('summary').click();
  const excerpt = sent.locator('pre').first();
  await expect(excerpt).toContainText('상호 배제, 점유 대기, 비선점, 순환 대기');
  await expect(excerpt).toContainText('Coffman conditions');

  // The original file is kept byte for byte.
  await page.goto(courseUrl);
  await page.getByRole('button', { name: 'text-lecture 작업' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: '원본 파일 내려받기' }).click()]);
  expect(download.suggestedFilename()).toBe('text-lecture.pdf');
  expect(readFileSync((await download.path())!)).toEqual(readFileSync(`${PDF_DIR}text-lecture.pdf`));

  expect(requests.filter((u) => !u.startsWith(new URL(page.url()).origin) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  expect(problems).toEqual([]);
});

test('scanned pages are shown and marked as having no text; nothing is made up', async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await createCourse(page, 'Scans');
  const courseUrl = page.url();

  await choose(page, [pdf('scanned-lecture.pdf'), pdf('jpeg2000-scan.pdf')]);
  await expect(page.getByText('가져옴: 2쪽')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('가져옴: 1쪽')).toBeVisible({ timeout: 30_000 });
  await expect(queue(page).getByRole('link', { name: '확인 필요 2쪽' })).toBeVisible();

  const id = await openLecture(page, 'scanned-lecture');
  await expectPageImage(page);
  await expect(page.getByText(/이 페이지에서 글자를 찾지 못했습니다/).first()).toBeVisible();

  await page.goto(`/search?q=${encodeURIComponent('Scanned page')}`);
  await expect(page.locator(`a[href^="/lecture/${id}"]`)).toHaveCount(0);

  // A JPEG 2000 scan is decoded by PDF.js's WebAssembly decoder, which the page's security policy must allow; otherwise the page is blank.
  await page.goto(courseUrl);
  await openLecture(page, 'jpeg2000-scan');
  await expectPageImage(page);
  expect(problems).toEqual([]);
});

test('broken and password-protected PDFs are refused with a reason; PowerPoint still imports', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Mixed');

  await choose(page, [pdf('broken.pdf'), pdf('encrypted.pdf'), { name: 'Lecture 4.pptx', mimeType: PPTX_MIME, buffer: lectureBytes() }]);
  await expect(page.getByText(/PDF 파일이 손상되었거나 구조를 읽을 수 없습니다/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/암호로 보호된 PDF입니다/)).toBeVisible();
  await expect(page.getByText('가져옴: 슬라이드 5장')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Lecture 4', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'broken', exact: true })).toHaveCount(0);
});

test('a queued file can be cancelled before it is read', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Cancel');
  await choose(page, [pdf('scanned-lecture.pdf'), pdf('text-lecture.pdf')]);
  await page.getByRole('button', { name: 'text-lecture.pdf 가져오기 취소' }).click();
  await expect(page.getByText('가져옴: 2쪽')).toBeVisible({ timeout: 30_000 });
  await expect(queue(page).getByRole('listitem').filter({ hasText: 'text-lecture.pdf' }).getByText('건너뜀')).toBeVisible();
  await expect(page.getByRole('link', { name: 'text-lecture', exact: true })).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the PDF import list and a PDF lecture have no WCAG A/AA violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const audit = async (where: string) => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations.map((v) => `${where}: ${v.id}: ${v.help}`)).toEqual([]);
    };
    await page.goto('/');
    await createCourse(page, `Audit ${scheme}`);
    await choose(page, [pdf('text-lecture.pdf'), pdf('scanned-lecture.pdf')]);
    await expect(queue(page).getByRole('button', { name: 'scanned-lecture.pdf 가져오기 취소' })).toBeVisible();
    await audit('course page while importing');
    await expect(page.getByText('가져옴: 2쪽')).toBeVisible({ timeout: 30_000 });
    await audit('course page with PDF lectures');
    const id = await openLecture(page, 'text-lecture');
    await expectPageImage(page);
    await audit('PDF text page');
    await page.goto(`/lecture/${id}?slide=3`);
    await expectPageImage(page);
    await audit('PDF page without text');
  });
}
