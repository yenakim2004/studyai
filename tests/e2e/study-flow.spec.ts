import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createCourse, importFiles, lectureBytes, trackRequests } from './helpers';

test.describe.configure({ mode: 'serial' });

test('upload → read → search → reload → backup → restore', async ({ page }, testInfo) => {
  const requests = trackRequests(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  await expect(page.getByText('과목부터 만드세요')).toBeVisible();

  // --- course + import -----------------------------------------------------
  await createCourse(page, 'Computability and Complexity', 'BCS303');
  const original = lectureBytes();
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: original }]);
  await expect(page.getByText(/가져옴: 슬라이드 5장/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lecture 4 - Turing machines' })).toBeVisible();
  await expect(page.getByText('슬라이드 5장').first()).toBeVisible();

  // --- reading -------------------------------------------------------------
  await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
  await expect(page.getByText('슬라이드 1/5')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('슬라이드 2/5')).toBeVisible();
  const content = page.getByRole('tabpanel');
  await expect(content.getByText('A tape that is infinite in both directions')).toBeVisible();
  await expect(content.getByText('A finite control with states')).toBeVisible();

  await page.getByRole('tab', { name: /발표자 노트/ }).click();
  await expect(content.getByText('Draw the 7-tuple on the board.')).toBeVisible();
  await page.getByRole('tab', { name: '내용' }).click();

  // provenance: clicking a shape on the slide highlights its extracted block
  await page.locator('section[aria-label="슬라이드"] .slide-stage [data-el="3"]').click();
  await expect(page.locator('#blk-3')).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: testInfo.outputPath('lecture-desktop.png') });

  // table slide
  await page.keyboard.press('ArrowRight');
  await expect(content.getByRole('table')).toBeVisible();
  await expect(content.getByRole('columnheader', { name: 'Halts on yes' })).toBeVisible();

  // equation slide: KaTeX renders in the extracted view
  await page.keyboard.press('ArrowRight');
  await expect(content.locator('.katex').first()).toBeVisible();

  // picture slide + checks tab honesty
  await page.keyboard.press('ArrowRight');
  await expect(content.getByText('State diagram of a simple machine')).toBeVisible();
  await page.getByRole('tab', { name: /확인 사항/ }).click();
  await expect(content.getByText(/추출하지 않은 텍스트, 도식, 스크린샷이 있을 수 있습니다/).first()).toBeVisible();

  // --- report --------------------------------------------------------------
  await page.getByRole('link', { name: /추출 보고서/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '추출 보고서' })).toBeVisible();
  await expect(page.getByText('빠졌을 수 있는 내용')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('report-desktop.png'), fullPage: true });

  // --- search --------------------------------------------------------------
  await page.getByLabel('모든 강의 검색').fill('unbounded');
  await page.getByLabel('모든 강의 검색').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=unbounded/);
  const hit = page.getByRole('link', { name: /Definition of a Turing machine/ });
  await expect(hit).toBeVisible();
  await expect(hit.getByText('발표자 노트')).toBeVisible(); // matched only in notes
  await expect(hit.locator('mark')).toContainText('unbounded');
  await page.screenshot({ path: testInfo.outputPath('search-desktop.png') });
  await hit.click();
  await expect(page.getByText('슬라이드 2/5')).toBeVisible();

  // --- persistence ---------------------------------------------------------
  await page.reload();
  await expect(page.getByText('슬라이드 2/5')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByText('A transition function')).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('이어서 공부하기')).toBeVisible();
  await expect(page.getByRole('link', { name: /Computability and Complexity/ }).first()).toBeVisible();

  // --- backup & restore ----------------------------------------------------
  await page.getByRole('link', { name: '설정과 백업' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '백업 내보내기' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^studyai-backup-\d{4}-\d{2}-\d{2}\.studyai\.zip$/);
  const backupPath = testInfo.outputPath('backup.studyai.zip');
  await download.saveAs(backupPath);
  expect(readFileSync(backupPath).subarray(0, 2).toString()).toBe('PK');

  // wipe the library completely
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise<void>((res) => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = () => res(); })));
  });
  await page.goto('/');
  await expect(page.getByText('과목부터 만드세요')).toBeVisible();

  await page.getByRole('link', { name: '설정과 백업' }).click();
  await page.locator('input[aria-label="백업 파일 고르기"]').setInputFiles(backupPath);
  const dialog = page.getByRole('dialog', { name: '백업에서 복원' });
  await expect(dialog.getByText('확인을 마쳤고 안전하게 읽을 수 있습니다.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('restore-dialog.png') });
  await dialog.getByRole('button', { name: '내 라이브러리에 합치기' }).click();
  await expect(page.getByText(/복원했습니다: 강의 1개\(슬라이드 5장\)/)).toBeVisible();

  await page.getByRole('link', { name: /Computability and Complexity/ }).first().click();
  await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
  await expect(page.getByText('슬라이드 1/5')).toBeVisible(); // wait for the lazily loaded page
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel').getByText('A tape that is infinite in both directions')).toBeVisible();
  // original file and images survived the round trip
  await page.getByRole('link', { name: /Computability and Complexity/ }).first().click();
  await page.getByRole('button', { name: /Lecture 4.* 작업/ }).click();
  const [orig] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: '원본 파일 내려받기' }).click()]);
  const origPath = testInfo.outputPath('original.pptx');
  await orig.saveAs(origPath);
  expect(readFileSync(origPath).equals(original)).toBe(true);

  // --- privacy: the app never talks to anyone but its own origin ------------
  const origin = new URL(page.url()).origin;
  const foreign = requests.filter((u) => !(u.startsWith(origin) || u.startsWith('blob:') || u.startsWith('data:')));
  expect(foreign, `unexpected network requests: ${foreign.join(', ')}`).toEqual([]);
});

test('duplicates and same-named files ask before doing anything', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Algorithms');
  const original = lectureBytes();
  await importFiles(page, [{ name: 'lec.pptx', buffer: original }]);
  await expect(page.getByText(/가져옴: 슬라이드 5장/)).toBeVisible();

  // exact same bytes again (different name) → duplicate prompt, default is skip
  await importFiles(page, [{ name: 'copy of lec.pptx', buffer: original }]);
  await expect(page.getByText(/똑같은 파일이 이미 자료실에 있습니다/)).toBeVisible();
  await page.getByRole('button', { name: '건너뛰기' }).click();
  await expect(page.getByText('건너뜀')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'copy of lec' })).toHaveCount(0 + 1); // only the queue row, no lecture row
  await expect(page.getByRole('link', { name: 'copy of lec' })).toHaveCount(0);

  // same file name, different content → offer to replace in place
  await page.getByRole('button', { name: '끝난 항목 지우기' }).click();
  await importFiles(page, [{ name: 'lec.pptx', buffer: lectureBytes({ suffix: ' (updated)' }) }]);
  await expect(page.getByText(/같은 이름의 파일로 만든 강의가 이미 있습니다/)).toBeVisible();
  await page.getByRole('button', { name: '기존 강의 바꾸기' }).click();
  await expect(page.getByText(/바꿈: 슬라이드 5장/)).toBeVisible();
  await page.getByRole('link', { name: 'lec', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByText('Turing Machines and Decidability (updated)')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('listitem').filter({ hasText: 'lec.pptx' })).toHaveCount(1);
});

test('rejects unsafe or unsupported files with clear messages', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Security');
  const input = page.locator('input[aria-label="강의 파일 선택"]');
  await input.setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'old.ppt', mimeType: 'application/vnd.ms-powerpoint', buffer: Buffer.from('x') },
    { name: 'fake.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a zip file but is long enough to be read') },
  ]);
  await expect(page.getByText('PowerPoint 파일(.pptx, .pptm, .ppsx, .potx)과 PDF 파일(.pdf)만 가져올 수 있습니다.')).toBeVisible();
  await expect(page.getByText(/예전 형식의 \.ppt 파일입니다/)).toBeVisible();
  await expect(page.getByText('올바른 .pptx 프레젠테이션 파일이 아닙니다.')).toBeVisible();
  await expect(page.getByText('아직 강의가 없습니다')).toBeVisible(); // nothing was stored
});
