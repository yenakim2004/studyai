import { expect, test } from '@playwright/test';
import { importPack, revealWithKeyboard, seed, tab, watchProblems } from './helpers';

test.describe.configure({ mode: 'serial' });

test('study pack → verified import → approve → spaced-repetition session → notes', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await seed(page);
  const dialog = await importPack(page);

  // the app, not the AI, decides what was really on the slides
  await expect(dialog.getByText(/인용문 5개 중 3개를 슬라이드에서 찾았습니다\(1개는 찾지 못함\)/)).toBeVisible();
  await expect(dialog.getByText('Lecture 4 - Turing machines', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pack-import.png') });
  await dialog.getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();
  await expect(page).toHaveURL(/\/cards\?status=pending/);
  await expect(page.getByText('검토할 카드 2장, 노트 1개, 문제 2개를 가져왔습니다.')).toBeVisible();

  // --- nothing is studyable until approved ---------------------------------
  await expect(page.getByRole('heading', { name: '결정을 기다리는 카드 2장' })).toBeVisible();
  await expect(page.getByRole('button', { name: '복습 시작' })).toBeDisabled();
  const invented = page.getByRole('listitem').filter({ hasText: 'How many cells does the tape hold?' });
  await expect(invented.getByText('슬라이드에서 인용문을 찾지 못함')).toBeVisible();
  await invented.getByRole('button', { name: '출처 보기(1)' }).click();
  await expect(invented.getByText('슬라이드에서 찾지 못함').last()).toBeVisible();
  const real = page.getByRole('listitem').filter({ hasText: 'What does the tape of a Turing machine look like?' });
  await expect(real.getByText('출처 확인됨')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cards-pending.png'), fullPage: true });

  // "approve all" skips anything whose quote was contradicted by the slides
  await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
  await expect(page.getByRole('heading', { name: '결정을 기다리는 카드 1장' })).toBeVisible();
  await invented.getByRole('button', { name: '거절' }).click();
  await expect(page.getByRole('heading', { name: /결정을 기다리는/ })).toHaveCount(0);

  // --- spaced repetition ----------------------------------------------------
  await page.getByRole('link', { name: '복습 시작' }).click();
  await expect(page.getByText('What does the tape of a Turing machine look like?')).toBeVisible();
  await expect(page.getByText('It is infinite in both directions.')).toBeHidden(); // answer hidden until requested
  await revealWithKeyboard(page);
  await expect(page.getByText('It is infinite in both directions.')).toBeVisible();
  await expect(page.getByText('출처 확인됨')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-card.png') });
  await expect(page.getByRole('button', { name: /^알맞음 10분/ })).toBeVisible(); // FSRS shows the next interval
  await page.keyboard.press('3');
  await expect(page.getByRole('heading', { name: '복습을 마쳤습니다' })).toBeVisible();
  await expect(page.getByText(/카드 1장에 답했고, 그중 1장이 알맞음 또는 쉬움이었습니다/)).toBeVisible();
  await page.getByRole('link', { name: '플래시카드로 돌아가기' }).click();
  await expect(page.getByText('오늘 복습').locator('..')).toContainText('1');

  // --- notes: generated vs yours ---------------------------------------------
  await tab(page, '노트').click();
  await page.getByRole('button', { name: '슬라이드로 노트 만들기' }).click();
  const gen = page.getByRole('dialog', { name: '슬라이드로 노트 만들기' });
  await expect(gen.getByText(/AI가 쓴 내용이 아닙니다/)).toBeVisible();
  await gen.getByRole('button', { name: '노트 만들기' }).click();
  await expect(page.getByText('노트 1개를 만들었습니다.')).toBeVisible();
  await page.getByRole('link', { name: /강의 노트/ }).click();
  await expect(page.getByText('슬라이드에서 자동 추출').first()).toBeVisible();
  await expect(page.getByText('A transition function').first()).toBeVisible();
  await expect(page.getByText('슬라이드 2: Definition of a Turing machine').first()).toBeVisible();

  await tab(page, '노트').click();
  await page.getByRole('link', { name: /Turing machine summary/ }).click();
  await expect(page.getByText('가져온 학습 팩')).toBeVisible();
  await page.getByRole('button', { name: '편집' }).first().click();
  await page.getByLabel(/^편집\(마크다운/).fill('A Turing machine has a **tape**, a *finite control* and a transition function.');
  await page.getByRole('button', { name: '블록 저장' }).click();
  await expect(page.getByText('내가 작성')).toBeVisible(); // my edit is labelled as mine
  await expect(page.getByText('가져온 학습 팩')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('note-editor.png') });
  expect(problems, 'console errors / CSP violations').toEqual([]);
});

test('question bank → exam with hints → autosave/resume → auto + self marking → repeat missed → paper', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await seed(page);
  await importPack(page);
  await page.getByRole('dialog', { name: '학습 팩 가져오기' }).getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();
  await tab(page, '연습과 시험').click();

  await expect(page.getByRole('heading', { name: '결정을 기다리는 문제 2개' })).toBeVisible();
  await expect(page.getByRole('button', { name: '시험 만들기' })).toBeDisabled(); // pending questions are never used
  await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
  await expect(page.getByText('문제 은행에 승인한 문제가 2개 있습니다.')).toBeVisible();

  await page.getByRole('button', { name: '시험 만들기' }).click();
  const builder = page.getByRole('dialog', { name: '모의시험 만들기' });
  await expect(builder.getByText(/승인된 문제 2개가 맞고, 그중 2개를 씁니다/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('exam-builder.png') });
  await builder.getByRole('button', { name: '시험 시작' }).click();

  // --- taking the exam ---------------------------------------------------------
  await expect(page.getByText('2문제 중 0문제 답함')).toBeVisible();
  const answerAll = async (mcqCorrect: boolean) => {
    for (let i = 0; i < 2; i++) {
      const main = page.getByRole('main', { name: '문제' });
      if (await main.getByText('Which statement about the tape is correct?').isVisible()) {
        await main.getByText(mcqCorrect ? 'It is infinite in both directions' : 'It has exactly 100 cells').click();
      } else {
        await expect(main.getByText('State two components of a Turing machine.')).toBeVisible();
        await main.getByRole('button', { name: '힌트 보기' }).click();
        await expect(main.getByText('힌트: Look at slide 2.')).toBeVisible();
        await main.getByLabel('내 답').fill('A Turing machine has a tape and a finite control.');
        await expect(main.getByText(/단어\(예상 3–30단어\)/)).toBeVisible();
      }
      if (i === 0) await page.getByRole('button', { name: '다음' }).click();
    }
  };
  await answerAll(false); // wrong on purpose
  await expect(page.getByText('2문제 중 2문제 답함')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('exam-taking.png') });

  // answers are autosaved: a reload resumes exactly here
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByText('2문제 중 2문제 답함')).toBeVisible();

  await page.getByRole('button', { name: '제출' }).first().click();
  const confirm = page.getByRole('dialog', { name: '시험을 제출할까요?' });
  await expect(confirm.getByText('2문제 중 2문제에 답했습니다.')).toBeVisible();
  await confirm.getByRole('button', { name: '지금 제출' }).click();

  // --- results: exact auto-marking, honest self-marking --------------------------
  await expect(page).toHaveURL(/\/results$/);
  await expect(page.getByRole('heading', { name: '잠정 점수' })).toBeVisible();
  await expect(page.getByText('채점할 서술형 답 1개')).toBeVisible();
  await expect(page.getByText('이 문제에서 힌트를 썼습니다.')).toBeVisible();
  const written = page.getByRole('listitem').filter({ hasText: 'State two components of a Turing machine.' });
  await expect(written.getByText('채점 필요')).toBeVisible();
  await expect(written.getByText('내 답에 들어 있는 것 같음').first()).toBeVisible(); // keyword hint, not a mark
  const mcqCard = page.getByRole('listitem').filter({ hasText: 'Which statement about the tape is correct?' });
  await expect(mcqCard.getByText('0점')).toBeVisible();
  await expect(mcqCard.getByText('자동 채점')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('results-provisional.png'), fullPage: true });

  await written.getByLabel('점수: Mentions the tape').fill('1');
  await written.getByLabel('점수: Mentions the finite control').fill('1');
  await written.getByRole('button', { name: '내 점수 저장' }).click();
  await expect(page.getByText('점수를 저장했습니다.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '내 점수' })).toBeVisible();
  await expect(page.locator('#score-h').locator('..')).toContainText('2');
  await expect(page.getByText('내가 채점, 추정치')).toBeVisible();
  await expect(page.getByText(/채점자의 점수가 아닙니다/)).toBeVisible();

  // --- repeat missed, resume ----------------------------------------------------
  await page.getByRole('button', { name: '틀린 문제 1개 다시 풀기' }).click();
  await expect(page.getByText('Which statement about the tape is correct?')).toBeVisible();
  await page.getByText('It is infinite in both directions').click();
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByLabel('It is infinite in both directions')).toBeChecked();
  await page.getByRole('button', { name: '제출' }).first().click();
  await page.getByRole('dialog', { name: '시험을 제출할까요?' }).getByRole('button', { name: '지금 제출' }).click();
  await expect(page.getByRole('heading', { name: '내 점수' })).toBeVisible();
  await expect(page.locator('#score-h').locator('..')).toContainText('2'); // 2 / 2, 100%
  await expect(page.getByRole('button', { name: '틀린 문제 0개 다시 풀기' })).toBeDisabled();

  // --- history and printable paper ------------------------------------------------
  await page.getByRole('navigation', { name: '이동 경로' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: '내 시험' })).toBeVisible();
  await expect(page.getByText(/4점 중 2점\(50%\)/)).toBeVisible();
  await expect(page.getByText(/2점 중 2점\(100%\)/)).toBeVisible();
  await page.getByRole('button', { name: /^다시 풀기: .* 작업$/ }).click();
  await page.getByRole('menuitem', { name: '인쇄용 시험지' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('다시 풀기:');
  await page.getByLabel('채점 기준 포함').check();
  await expect(page.getByText('A tape and a finite control.').or(page.getByText('It is infinite in both directions').last())).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('paper.png'), fullPage: true });
  expect(problems, 'console errors / CSP violations').toEqual([]);
});

test('everything you studied survives backup and restore', async ({ page }, testInfo) => {
  await seed(page);
  await importPack(page);
  await page.getByRole('dialog', { name: '학습 팩 가져오기' }).getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();
  await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
  await page.getByRole('link', { name: '복습 시작' }).click();
  await expect(page.getByRole('button', { name: '답 보기' })).toBeVisible();
  await revealWithKeyboard(page);
  await page.keyboard.press('4');
  await expect(page.getByRole('heading', { name: '복습을 마쳤습니다' })).toBeVisible();

  await page.goto('/settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '백업 내보내기' }).click()]);
  const path = testInfo.outputPath('backup.studyai.zip');
  await download.saveAs(path);
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise<void>((res) => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = () => res(); })));
  });
  await page.goto('/settings');
  await page.locator('input[aria-label="백업 파일 고르기"]').setInputFiles(path);
  await page.getByRole('dialog', { name: '백업에서 복원' }).getByRole('button', { name: '내 라이브러리에 합치기' }).click();
  await expect(page.getByText(/복원했습니다: 강의 1개/)).toBeVisible();

  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, /^플래시카드/).click();
  await expect(page.getByText('모든 카드(2)')).toBeVisible();
  await expect(page.getByText('오늘 복습').locator('..')).toContainText('1'); // review history came back too
  await tab(page, '연습과 시험').click();
  await expect(page.getByRole('heading', { name: '결정을 기다리는 문제 2개' })).toBeVisible(); // still pending after restore
});

test('dashboard reflects real activity and gives one reasoned next step', async ({ page }, testInfo) => {
  await seed(page);
  await page.goto('/');
  const next = page.getByRole('region', { name: '다음 할 일' }).or(page.locator('section[aria-labelledby="next-h"]'));
  await expect(next.getByText('“Lecture 4 - Turing machines” 공부하기')).toBeVisible();
  await expect(next.getByText('아직 이 강의를 열지 않았습니다.')).toBeVisible();
  await expect(page.getByText('0% 학습')).toBeVisible();

  // slides only count once they have been on screen for a few seconds
  await next.getByRole('link').click();
  await expect(page.getByText('슬라이드 1/5')).toBeVisible();
  await page.waitForTimeout(3600);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // flicked past: must not count
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText('슬라이드 2/5')).toBeVisible();
  await page.waitForTimeout(3600);

  await page.goto('/');
  await expect(page.getByText('오늘 공부한 슬라이드').locator('..')).toContainText('2');
  await expect(page.getByText('40% 학습')).toBeVisible();
  // the lecture is open at slide 2: one card says where you left off, counts what was viewed, and links to that slide
  await expect(next.getByText('전체 5장 중 2번째 슬라이드에서 멈췄습니다. 지금까지 2장을 봤습니다.')).toBeVisible();
  await expect(next.getByText('이어서 공부하기')).toBeVisible();
  await expect(next.getByRole('link')).toHaveAttribute('href', /\?slide=2$/);

  // import a pack: imported items are never studied, so the app asks you to check them first
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await importPack(page);
  await page.getByRole('dialog', { name: '학습 팩 가져오기' }).getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();
  await expect(page.getByText('검토할 카드 2장, 노트 1개, 문제 2개를 가져왔습니다.')).toBeVisible(); // stored before leaving the page
  await page.goto('/');
  await expect(next.getByText('Computability에서 가져온 항목 4개 확인하기')).toBeVisible();

  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, /^플래시카드/).click();
  await page.getByRole('button', { name: /^출처 문제가 없는 (?:카드|문제) 모두 승인$/ }).click();
  await page.getByRole('link', { name: '복습 시작' }).click();
  await expect(page.getByText('What does the tape of a Turing machine look like?')).toBeVisible(); // wait for the lazily loaded page
  await revealWithKeyboard(page);
  await page.keyboard.press('3');
  await expect(page.getByRole('heading', { name: '복습을 마쳤습니다' })).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('오늘 복습한 카드').locator('..')).toContainText('1');
  const sessions = page.getByRole('heading', { name: '최근 공부 기록' }).locator('..');
  await expect(sessions).toContainText('슬라이드 2장 봄');
  await expect(sessions).toContainText('카드 1장 복습');
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
});
