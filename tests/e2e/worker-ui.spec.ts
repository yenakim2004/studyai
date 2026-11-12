import { ORIGINS } from './ports';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createCourse, importFiles, importPack, revealWithKeyboard, seed, tab, trackRequests, watchProblems } from './helpers';
import { mathDeck } from '../fixtures/math-deck';
import { connectChatGpt as signIn, resetChatGpt } from './worker-connect';
import { buildPptx, simpleSlide } from '../fixtures/pptx-builder';

/**
 * The real interface against the real local Worker + Durable Object, connected to the fake OpenAI issuer whose scripted
 * model reads each request (tests/helpers/scripted-model.mjs). Serial: the Durable Object keeps the connection between
 * tests, as in production. There is no StudyAI key or login.
 */
test.describe.configure({ mode: 'serial' });

test('Settings: connect the ChatGPT plan with no key or StudyAI login, and AI is ready', async ({ page, request }, testInfo) => {
  await resetChatGpt(request);
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'AI 학습 도우미' })).toBeVisible();
  await expect(page.getByText('꺼짐', { exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await audit(page, 'settings: not connected');
  await signIn(page);
  await expect(page.getByText('연결된 계정: student@example.test')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-ai.png'), fullPage: true });
  await audit(page, 'settings: AI ready');
  expect(requests.filter((u) => !u.startsWith(ORIGINS.worker) && !u.startsWith('http://localhost:') && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  expect(problems).toEqual([]);
});

test('the AI 튜터: shows what will be sent, answers with sources, and records nothing it should not', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI 튜터').click();

  const q = page.getByLabel('내 질문');
  await q.fill('What is a transition function?');
  const sendInfo = page.getByText(/OpenAI \(내 ChatGPT 플랜\)에 보낼 내용: 내 질문, 슬라이드 \d+장/);
  await expect(sendInfo).toBeVisible(); // slides matching the question were found automatically
  await sendInfo.click();
  await expect(page.getByText(/파일, 이미지, 계정 정보, 다른 슬라이드는 보내지 않으며/)).toBeVisible();
  await expect(page.locator('details pre').first()).toContainText('transition function');

  // consent is needed once; until then sending is impossible
  await expect(page.getByRole('button', { name: /보내기$/ })).toBeDisabled();
  await page.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).click(); // the notice disappears once accepted
  await page.getByRole('button', { name: /보내기$/ }).click();

  const answer = page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' });
  await expect(answer).toBeVisible();
  await expect(answer.getByText(/슬라이드에 있음/)).toBeVisible();
  await expect(answer).toContainText(/\[슬라이드 \d+\]/); // the saved text names real slides, never a label that only meant something inside one request
  await expect(answer).not.toContainText('[S1]');
  await expect(page.getByText(/슬라이드 \d+장과 함께 보냄 · 쉽게 설명/)).toBeVisible();
  await expect(answer.getByRole('button', { name: /^출처 보기\(\d\)$/ })).toBeVisible();
  await answer.getByRole('button', { name: /^출처 보기\(\d\)$/ }).click();
  await expect(answer.getByRole('link', { name: /Lecture 4.*슬라이드 \d/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tutor.png') });
  await audit(page, 'tutor: answer with sources and follow-ups');

  // follow-ups: the model's suggested questions fill the box
  await answer.getByRole('button', { name: 'What is the head?' }).click();
  await expect(q).toHaveValue('What is the head?');

  // answers can become notes and (pending) flashcards, marked as AI-written
  await answer.getByRole('button', { name: '노트로 저장' }).click();
  await expect(page.getByText('노트로 저장했습니다. AI가 쓴 것으로 표시됩니다.')).toBeVisible();
  await answer.getByRole('button', { name: '플래시카드 만들기' }).click();
  await expect(page.getByText('승인을 기다리는 플래시카드로 추가했습니다.')).toBeVisible();
  await tab(page, '노트').click();
  await expect(page.getByRole('link', { name: /What is a transition function\?/ }).filter({ has: page.locator('span', { hasText: '블록' }) })).toHaveAttribute('href', /\/notes\/[^/]+$/);
  await tab(page, /^플래시카드/).click();
  await expect(page.getByRole('heading', { name: /결정을 기다리는 카드/ })).toBeVisible(); // AI cards are pending until you approve them
  await tab(page, 'AI 튜터').click();

  // a model that claims "on the slides" without citing them is downgraded, never shown as trusted
  await page.getByLabel('내 질문').fill('FAKE-NOCITE what is a tape');
  await page.getByRole('button', { name: /보내기$/ }).click();
  const unsure = page.getByRole('listitem').filter({ hasText: 'A confident answer with no citation at all.' });
  await expect(unsure.getByText('불확실', { exact: true })).toBeVisible();

  // the plan's usage limit is shown plainly in Korean, and then the tutor stops by itself
  await page.getByLabel('내 질문').fill('FAKE-USAGE-LIMIT transition function');
  await page.getByRole('button', { name: /보내기$/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ChatGPT 플랜의 사용 한도에 도달했습니다' })).toBeVisible();
  await expect(page.getByText('튜터가 아직 준비되지 않았습니다')).toBeVisible();
  await page.getByLabel('내 질문').fill('Another question about the tape');
  await expect(page.getByRole('button', { name: /보내기$/ })).toBeDisabled();

  // back in Settings the student sees why, checks, and resumes
  await page.goto('/settings');
  await expect(page.getByText('멈춤', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '다시 시작' }).click();
  await expect(page.getByText('사용 가능', { exact: true })).toBeVisible();
  // the only console noise is the browser logging the refusal this test provokes on purpose (the usage limit, 429)
  expect(problems.filter((p) => !/status of 429 /.test(p))).toEqual([]);
});

test('chats are kept on this device: the answer, its citation, its sources and its follow-up chips survive a reload', async ({ page }) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI 튜터').click();
  await page.getByLabel('내 질문').fill('What is a transition function?');
  await page.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).click(); // a fresh browser has not accepted yet; the box appears once the AI status has loaded
  await page.getByRole('button', { name: /보내기$/ }).click();
  const answer = page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' });
  await expect(answer).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^What is a transition function/ }).click(); // the chat is in the list on the left
  const again = page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' });
  await expect(again).toBeVisible();
  await expect(again).toContainText(/\[슬라이드 \d+\]/);
  await expect(again.getByRole('button', { name: /^출처 보기\(\d\)$/ })).toBeVisible();
  await expect(again.getByRole('button', { name: 'What is the head?' })).toBeVisible();
  await expect(page.getByText(/슬라이드 \d+장과 함께 보냄 · 쉽게 설명/)).toBeVisible();
});

test('the AI 튜터 writes cards and questions, but they go through the normal checking screen', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await page.getByRole('button', { name: '학습 팩 만들기와 가져오기' }).click();
  await page.getByRole('menuitem', { name: 'AI 학습 자료 생성…' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI로 학습 자료 만들기' });
  await expect(dialog.getByText(/OpenAI \(내 ChatGPT 플랜\)에 보낼 내용: 강의 1개의 텍스트/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '만들고 확인하기' })).toBeDisabled(); // The request stays disabled until consent.

  // only the chosen slides are sent: leaving out the title slide removes it from what is shown, and an impossible range blocks sending
  const first = dialog.getByLabel(/의 첫 슬라이드$/);
  await first.fill('2');
  await expect(dialog.getByText(/의 슬라이드 2–5/)).toBeVisible();
  await dialog.getByText(/OpenAI \(내 ChatGPT 플랜\)/).click();
  await expect(dialog.locator('pre')).not.toContainText('### Slide 1:');
  await expect(dialog.locator('pre')).toContainText('### Slide 2: Definition of a Turing machine');
  await first.fill('9');
  await expect(dialog.getByText(/1부터 5까지의 정수/)).toBeVisible();
  await first.fill('1');
  await expect(dialog.locator('pre')).toContainText('### Slide 1:');

  // exam questions are planned on the device first: a visible mix, said not to predict the real exam
  const examPlan = dialog.getByRole('region', { name: '시험 계획' });
  await expect(examPlan).toContainText(/시험 계획: 문제 \d+개, 요청 \d+번/);
  await expect(examPlan).toContainText(/실제 시험을 예측하지 않습니다/);
  await expect(examPlan.getByText('(이번 요청)').first()).toBeVisible();
  const planned = (await examPlan.getByRole('listitem').allInnerTexts()).length;
  expect(planned).toBeGreaterThanOrEqual(2);
  // the preview (opened above) says that the plan is sent with the slides
  await expect(dialog.getByText(/함께 보내는 것: 이번 요청의 위 계획/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('exam-plan.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('exam-plan-phone.png') });
  await page.setViewportSize({ width: 1280, height: 720 });

  await dialog.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).click();
  await dialog.getByRole('button', { name: '만들고 확인하기' }).click();

  // the pack arrives in the usual import check: quotes verified against the slides, nothing used until approved
  const check = page.getByRole('dialog', { name: '학습 팩 가져오기' });
  await expect(check.getByText(/개를 슬라이드에서 찾았습니다/)).toBeVisible();
  await expect(check.getByText('플래시카드')).toBeVisible();
  // what came back is held to the plan it was written for
  const questionSet = check.getByRole('region', { name: '이 팩의 시험 문제' });
  await expect(questionSet).toContainText(/시험 문제 \d+개 · 총 \d+점/);
  await expect(questionSet).toContainText(/난이도: 쉬움 \d+, 보통 \d+, 어려움 \d+/);
  await expect(questionSet).toContainText(/계획한 \d+개 중 \d+개가 계획대로 돌아왔습니다/);
  await page.screenshot({ path: testInfo.outputPath('question-set.png') });
  await check.getByRole('button', { name: /^검토할 항목 \d+개 가져오기$/ }).click();
  await tab(page, /^플래시카드/).click();
  await expect(page.getByText('What does the first slide introduce?').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /결정을 기다리는 카드/ })).toBeVisible();
});

test('AI marking is a labelled estimate that you can accept or discard', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await importPack(page);
  await page.getByRole('dialog', { name: '학습 팩 가져오기' }).getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();
  await tab(page, '연습과 시험').click();
  await page.getByRole('button', { name: /출처 문제가 없는 .* 모두 승인/ }).click();
  await page.getByRole('button', { name: '시험 만들기' }).click();
  await page.getByRole('dialog', { name: '모의시험 만들기' }).getByRole('button', { name: '시험 시작' }).click();

  await expect(page.getByText('2문제 중 0문제 답함')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    const main = page.getByRole('main', { name: '문제' });
    await expect(main).toBeVisible();
    if (await main.getByText('Which statement about the tape is correct?').isVisible()) await main.getByText('It is infinite in both directions').click();
    else await main.getByLabel('내 답').fill('A Turing machine has a tape and a finite control.');
    if (i === 0) await page.getByRole('button', { name: '다음' }).click();
  }
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '제출' }).first().click();
  await page.getByRole('dialog', { name: '시험을 제출할까요?' }).getByRole('button', { name: '지금 제출' }).click();
  await expect(page).toHaveURL(/\/results$/);

  const written = page.getByRole('listitem').filter({ hasText: 'State two components of a Turing machine.' });
  await expect(written.getByText('AI의 두 번째 의견(선택)')).toBeVisible();
  await expect(written.getByText(/채점자의 점수가 아닌 추정치/i)).toBeVisible();
  await written.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).click();
  await written.getByRole('button', { name: 'AI에게 채점 요청' }).click();
  const suggestion = written.getByLabel('AI가 제안한 점수');
  await expect(suggestion.getByText(/제안:/)).toContainText('1');
  await expect(suggestion.getByText(/AI의 확신도: 보통/)).toBeVisible();
  await expect(suggestion.getByText('Mentions the tape')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ai-marking.png'), fullPage: true });
  await audit(page, 'results: AI marking proposal');

  await suggestion.getByRole('button', { name: '이 점수 쓰기' }).click();
  await expect(written.getByText('AI 추정(직접 확인하세요)')).toBeVisible();
  // the saved marks are shown in the marker below, where you can still change them
  await expect(written.getByLabel('점수: Mentions the tape')).toHaveValue('1');

  // and the question can be taken to the tutor, already typed, with its source slide chosen
  await written.getByRole('link', { name: '튜터에게 묻기' }).click();
  await expect(page.getByLabel('내 질문')).toHaveValue(/^이 시험 문제에 어떻게 답해야 하는지, 좋은 답에는 무엇이 필요한지 설명해 주세요: State two components of a Turing machine\./);
  await expect(page.getByLabel('내가 고른 슬라이드')).toBeChecked();
});

test('a flashcard opens the tutor with its question and slide ready', async ({ page }) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await importPack(page);
  await page.getByRole('dialog', { name: '학습 팩 가져오기' }).getByRole('button', { name: '검토할 항목 5개 가져오기' }).click();
  // the note that arrived with the pack is not YOUR note until you write in it; only your own words are offered to the tutor
  await tab(page, '노트').click();
  await page.getByRole('link', { name: /Turing machine summary/ }).click();
  await page.getByRole('button', { name: '편집' }).first().click();
  await page.getByLabel(/^편집\(마크다운/).fill('My own summary: a Turing machine has a tape, a finite control and a transition function.');
  await page.getByRole('button', { name: '블록 저장' }).click();
  await expect(page.getByText('내가 작성')).toBeVisible();
  await tab(page, /^플래시카드/).click();
  await page.getByRole('button', { name: /출처 문제가 없는 .* 모두 승인/ }).click();
  await page.getByRole('link', { name: '복습 시작' }).click();
  await expect(page.getByRole('button', { name: '답 보기' })).toBeVisible();
  await revealWithKeyboard(page);
  await page.getByRole('link', { name: '튜터에게 묻기' }).click();

  // the question is already typed, the card's slide is already chosen, and nothing has been sent yet
  await expect(page.getByLabel('내 질문')).toHaveValue(/^이 플래시카드를 설명해 주세요: What does the tape of a Turing machine look like\?/);
  await expect(page.getByLabel('내가 고른 슬라이드')).toBeChecked();
  await expect(page.getByText(/OpenAI \(내 ChatGPT 플랜\)에 보낼 내용: 내 질문, 슬라이드 1장/)).toBeVisible();
  await expect(page.getByText('대화는 이 기기에만 보관됩니다.')).toBeVisible(); // no chat was created by opening it
  expect(page.url()).not.toContain('Explain'); // the typed question travels in router state, not in the address

  // your own notes can be added as extra context; they are listed, labelled as notes, before anything is sent
  await page.getByLabel(/질문에 맞는 내 노트도 최대 3개까지/).check();
  await expect(page.getByText(/내 질문, 슬라이드 1장, 내 노트 1개/)).toBeVisible();
  await page.getByText(/OpenAI \(내 ChatGPT 플랜\)/).click();
  await expect(page.getByText('내 노트: Turing machine summary')).toBeVisible();
  await expect(page.getByText(/교수의 자료가 아니라 내 노트라고 표시/)).toBeVisible();
}); 

test('a guided lesson teaches the lecture part by part, in slide order, sending only the chosen part each time', async ({ page }) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI 튜터').click();

  await page.getByRole('button', { name: '처음부터 차근차근 배우기' }).click();
  // part 1 is chosen, the style is step by step, the question is typed for the student to read; nothing was sent
  const parts = page.getByRole('list', { name: '수업 단계' }).getByRole('button');
  await expect(parts.first()).toHaveAttribute('aria-current', 'step');
  await expect(page.getByLabel('설명 방식')).toHaveValue('steps');
  await expect(page.getByLabel('내 질문')).toHaveValue(/^".+"\(슬라이드 [\d–]+\)을\(를\) 내가 아직 아무것도 모른다고 생각하고 처음부터 슬라이드 순서대로 가르쳐 주세요\. 이 슬라이드만 사용하세요\./);
  await expect(page.getByText(/OpenAI \(내 ChatGPT 플랜\)에 보낼 내용: 내 질문, 슬라이드 \d장/)).toBeVisible();
  await expect(page.getByText('대화는 이 기기에만 보관됩니다.')).toBeVisible();

  await page.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).click();
  await page.getByRole('button', { name: /보내기$/ }).click();
  await expect(page.getByText(/슬라이드 \d장과 함께 보냄 · 단계별 설명/)).toBeVisible();

  // the next part continues the lesson with the following slides, and only those
  const next = page.getByRole('button', { name: /^다음 부분:/ });
  await expect(next).toBeVisible();
  await next.click();
  await expect(parts.nth(1)).toHaveAttribute('aria-current', 'step');
  // the next part names what was really taught before it, so it can connect to it
  await expect(page.getByLabel('내 질문')).toHaveValue(/^이제 다음 부분 ".+"\(슬라이드 [\d–]+\)을\(를\) 슬라이드 순서대로 가르쳐 주세요\. 지금까지 배운 내용과 연결해 주세요 \(지금까지 .+ \(슬라이드 [\d–]+\)을\(를\) 배웠습니다\.\)\./);

  // going back to an earlier part starts it from the beginning instead of pretending to continue
  await parts.first().click();
  await expect(page.getByLabel('내 질문')).toHaveValue(/^".+".*처음부터 슬라이드 순서대로/);
  await expect(parts.first()).toHaveAttribute('aria-current', 'step');

  // choosing a later part again names only the part that was really sent, and a new chat has covered nothing
  await parts.nth(1).click();
  await expect(page.getByLabel('내 질문')).toHaveValue(/지금까지/);
  await page.getByRole('button', { name: '새 대화' }).click();
  await parts.nth(1).click();
  await expect(page.getByLabel('내 질문')).toHaveValue(/^".+".*처음부터 슬라이드 순서대로/); // a new chat has covered nothing
});

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, label + ': ' + bad.join(' ; ')).toEqual([]);
}

test('the student sees what the slides do not say before anything is sent, and the tutor is told', async ({ page }, testInfo) => {
  await page.goto('/');
  await createCourse(page, 'Security', 'SEC1');
  await importFiles(page, [
    {
      name: 'Gaps.pptx',
      buffer: Buffer.from(buildPptx({ slides: [simpleSlide('Buffer overflows', ['Introduction']), simpleSlide('Firewalls', ['A firewall filters network traffic using rules and blocks packets from untrusted addresses', 'It also logs every blocked attempt for later review'])] })),
    },
  ]);
  await expect(page.getByText(/가져옴: 슬라이드 2장/)).toBeVisible();
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Security/ }).first().click();
  await tab(page, 'AI 튜터').click();

  await page.getByRole('radio', { name: '내가 고른 슬라이드' }).check();
  await page.getByRole('checkbox', { name: /^2\. / }).check();
  await expect(page.getByRole('note', { name: '이 슬라이드에서 찾은 빈틈' })).toHaveCount(0); // a slide that explains itself has no gaps
  await page.getByRole('checkbox', { name: /^1\. / }).check();
  const gaps = page.getByRole('note', { name: '이 슬라이드에서 찾은 빈틈' });
  await expect(gaps).toContainText('튜터가 이 슬라이드에서 짚어 줄 빈틈');
  await expect(gaps).toContainText('1번 슬라이드(“Buffer overflows”)에는 제목만 있어 그 자체로는 아무것도 설명하지 않습니다.');
  await page.getByLabel('내 질문').fill('Explain buffer overflows using these slides.');
  await page.getByText(/OpenAI \(내 ChatGPT 플랜\)/).click();
  await expect(page.getByText(/위에 보인 빈틈 메모 1개\(내 기기에서 찾음\)/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('gaps.png') });

  // the request with the gap notes is accepted by the server and answered
  const consent = page.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/);
  if (await consent.isVisible()) await consent.click();
  await page.getByRole('button', { name: /보내기$/ }).click();
  await expect(page.getByText(/슬라이드 2장과 함께 보냄/)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' })).toBeVisible();

  // leave the heading-only slide out and the note goes away
  await page.getByRole('checkbox', { name: /^1\. / }).uncheck();
  await expect(page.getByRole('note', { name: '이 슬라이드에서 찾은 빈틈' })).toHaveCount(0);
});

test('a mathematical lecture: the student sees which symbols a slide never explains, and the formulas and code go with the question as written', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Algorithms', 'CS201');
  await importFiles(page, [{ name: 'Divide and conquer.pptx', buffer: Buffer.from(mathDeck()) }]);
  await expect(page.getByText(/가져옴: 슬라이드 12장/)).toBeVisible();
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Algorithms/ }).first().click();
  await tab(page, 'AI 튜터').click();

  await page.getByRole('radio', { name: '내가 고른 슬라이드' }).check();
  for (const n of [4, 5, 8]) await page.getByRole('checkbox', { name: new RegExp(`^${n}\. `) }).check();
  const gaps = page.getByRole('note', { name: '이 슬라이드에서 찾은 빈틈' });
  await expect(gaps).toContainText('에 공식이 있지만 슬라이드가 기호의 뜻을 말하지 않습니다(설명 없는 기호: i).');
  await expect(gaps).toContainText('“on the board”');
  await expect(gaps).not.toContainText('5번 슬라이드'); // the proof uses its own symbols in words
  await page.getByLabel('내 질문').fill('Teach me the sum and its proof, then the merge sort code.');
  await page.getByText(/OpenAI \(내 ChatGPT 플랜\)/).click();
  const sent = page.locator('details').filter({ hasText: 'OpenAI (내 ChatGPT 플랜)에 보낼 내용' }).first();
  await expect(sent).toContainText('S1 Divide and conquer, 슬라이드 4: Sum of the first n integers');
  await expect(sent).toContainText('$$\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}$$');
  await expect(sent).toContainText('  if p < r'); // the code keeps its indentation and its < on the screen that shows what is sent

  const consent = page.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/);
  if (await consent.isVisible()) await consent.click();
  await page.getByRole('button', { name: /보내기$/ }).click();
  await expect(page.getByText(/슬라이드 3장과 함께 보냄/)).toBeVisible();
});

test('the AI의 채점 기준 점검 finds a point nobody asked for, and removing it takes its marks off', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  const pack = {
    format: 'studyai-pack',
    version: 1,
    lectures: [{ ref: 'L1', title: 'Lecture 4 - Turing machines' }],
    questions: [
      {
        type: 'short',
        prompt: 'State two components of a Turing machine and say what each one does.',
        marks: 3,
        difficulty: 2,
        topic: 'Turing machines',
        asks: [{ quote: 'State two components of a Turing machine', count: 2 }],
        modelAnswer: 'A tape that holds the symbols, and a head that reads and writes them.',
        rubric: [
          { text: 'A tape that holds the symbols', marks: 1, ask: 1 },
          { text: 'A head that reads and writes the symbols', marks: 1, ask: 1 },
          { text: 'Turing machines were described in 1936 FAKE-NOT-ASKED', marks: 1, ask: 1 },
        ],
        basis: 'derived',
        sources: [],
      },
    ],
  };
  await page.getByRole('button', { name: '학습 팩 만들기와 가져오기' }).click();
  await page.getByRole('menuitem', { name: '학습 팩 가져오기…' }).click();
  const imp = page.getByRole('dialog', { name: '학습 팩 가져오기' });
  await imp.getByLabel('팩 JSON').fill(JSON.stringify(pack));
  await imp.getByRole('button', { name: '이 팩 확인' }).click();

  // the device's own check already sees that three points answer an ask for two
  await imp.getByText(/건너뛴 항목 \d+개, 경고 \d+개/).click();
  await expect(imp.getByText(/이에 답하는 채점 기준은 3개입니다. 남는 점수는 문제에서 요구하지 않은 것입니다/)).toBeVisible();
  await expect(imp.getByText(/시험 문제 1개 · 총 3점/)).toBeVisible();

  // the AI check: what is sent is shown, nothing is sent before consent and a press
  const panel = imp.getByRole('region', { name: 'AI의 채점 기준 점검' });
  await expect(panel.getByText(/요청 한 번으로/)).toBeVisible();
  await panel.getByText('OpenAI (내 ChatGPT 플랜)에 보낼 내용').click();
  await expect(panel).toContainText('State two components of a Turing machine and say what each one does.');
  await expect(panel).toContainText('(채점 기준 3개)');
  await expect(panel.getByRole('button', { name: 'AI로 점검' })).toBeDisabled();
  await panel.getByLabel(/OpenAI에 보내진다는 것을 이해합니다/).click();
  await panel.getByRole('button', { name: 'AI로 점검' }).click();
  const found = panel.getByLabel('AI가 찾은 것');
  await expect(found.getByText(/살펴볼 것 1개를 찾았습니다/)).toBeVisible();
  await expect(found.getByText(/채점 기준 3\("Turing machines were described in 1936 FAKE-NOT-AS…"\)은\(는\) 문제에서 요구하지 않습니다\. The question never asks for this\./)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('audit-found.png'), fullPage: true });
  await audit(page, 'import: AI의 채점 기준 점검');

  // removing the point takes its mark off the question and clears the warning
  await found.getByRole('button', { name: '문제 1의 채점 기준 3 삭제' }).click();
  await expect(imp.getByText(/시험 문제 1개 · 총 2점/)).toBeVisible();
  await expect(imp.getByText(/남는 점수는 문제에서 요구하지 않은 것입니다/)).toHaveCount(0);
  await expect(found.getByText('AI가 표시한 것을 모두 처리했습니다.')).toBeVisible(); // the finding is gone; the AI is not asked again by itself
  await expect(found.getByRole('button')).toHaveCount(0);
  await imp.getByRole('button', { name: '검토할 항목 1개 가져오기' }).click();
  await tab(page, '연습과 시험').click();
  await page.getByRole('button', { name: /출처 문제가 없는 .* 모두 승인/ }).click();
  await expect(page.getByText('문제 은행에 승인한 문제가 1개 있습니다.')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the AI screens have no WCAG A/AA violations (${scheme})`, async ({ page, request }) => {
    await resetChatGpt(request);
    await page.emulateMedia({ colorScheme: scheme });
    await seed(page);
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: 'ChatGPT로 계속하기' })).toBeVisible();
    await audit(page, 'settings: not connected');
    await page.goto('/');
    await page.getByRole('link', { name: /Computability/ }).first().click();
    await tab(page, 'AI 튜터').click();
    await expect(page.getByLabel('내 질문')).toBeVisible();
    await audit(page, 'tutor: not ready');
  });
}
