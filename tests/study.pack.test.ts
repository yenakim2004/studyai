import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadSlides } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { displayTitle } from '../src/core/pptx/topics';
import { extractJson, normForMatch, planPack, quoteInText, recoverTruncatedJson, sourceStatus, type LectureContext } from '../src/core/study/pack';
import { packCounts } from '../src/core/study/pack-format';
import { lectureToMarkdown, studyPackPrompt } from '../src/core/study/markdown';
import { applyPackPlan, removePack, updateCard } from '../src/core/study/store';
import { BACKUP_VERSION, applyBackup, exportBackup, readBackup } from '../src/core/backup/backup';
import { bodySp, buildPptx, equationShape, mr, para, simpleSlide, tableFrame, titleSp, type DeckSpec } from './fixtures/pptx-builder';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`pk-${Date.now()}-${n++}`);
});

const SPEC: DeckSpec = {
  slides: [
    simpleSlide('Halting problem', ['The halting problem is undecidable', 'Proof by contradiction using diagonalisation'], 'Mention Turing 1936'),
    { shapes: titleSp(2, 'Reductions') + bodySp(3, [para('If A reduces to B and B is decidable then A is decidable')]) },
    { shapes: titleSp(2, 'Comparison') + tableFrame(4, [['Class', 'Verify', 'Solve'], ['P', 'poly', 'poly'], ['NP', 'poly', 'unknown']]) },
    { shapes: titleSp(2, 'Ratio') + equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`) },
  ],
};

async function setup() {
  const course = await createCourse(db, { name: 'Computability' });
  const bytes = buildPptx(SPEC);
  const deck = await parsePptx(bytes);
  const lecture = await importLecture(db, { courseId: course.id, fileName: 'Lecture 7 Undecidability.pptx', bytes, deck });
  const slides = await loadSlides(db, lecture.id);
  const ctx: LectureContext = {
    id: lecture.id,
    title: lecture.title,
    fileHash: lecture.fileHash,
    revision: lecture.revision,
    slideCount: lecture.slideCount,
    slideText: (i) => {
      const s = slides[i - 1];
      return s ? `${displayTitle(s)}\n${s.text}\n${s.notes}` : undefined;
    },
  };
  return { course, lecture, slides, ctx, deck };
}

const pack = (over: Record<string, unknown> = {}) => ({
  format: 'studyai-pack',
  version: 1,
  generator: 'Test AI 2026-10-16',
  lectures: [{ ref: 'L1', title: 'Lecture 7 Undecidability' }],
  notes: [],
  cards: [],
  questions: [],
  ...over,
});

describe('extractJson', () => {
  it('finds the object in fences or chatter', () => {
    expect(extractJson('Here you go!\n```json\n{"a": 1}\n```\nHope it helps')).toEqual({ a: 1 });
    expect(extractJson('{"a": 2}')).toEqual({ a: 2 });
    expect(extractJson('Sure: {"a": {"b": 3}} thanks')).toEqual({ a: { b: 3 } });
  });
  it('explains failures', () => {
    expect(() => extractJson('no json here')).toThrow(/JSON 객체를 찾지 못했습니다/);
    expect(() => extractJson('{"a": ')).toThrow(/JSON 객체를 찾지 못했습니다|JSON을 읽을 수 없습니다/);
    expect(() => extractJson('{"a": nope}')).toThrow(/JSON을 읽을 수 없습니다/);
  });
});

describe('quote verification', () => {
  it('ignores markdown, LaTeX, punctuation and case', () => {
    const hay = 'The halting problem is undecidable\nA_{TM} is reducible to HALT_{TM}';
    expect(normForMatch('**The** Halting-Problem  is…')).toBe('the halting problem is');
    expect(quoteInText('"The halting problem is undecidable"', hay)).toBe(true);
    expect(quoteInText('$A_{TM}$ is reducible to $HALT_{TM}$', hay)).toBe(true);
    expect(quoteInText('the halting problem ... is undecidable', hay)).toBe(true); // ellipsis fragments
  });
  it('matches quotes copied from the Markdown export where equations appear as LaTeX', () => {
    const slide = 'If we know that some problem (say A_{TM}) is undecidable we can use that\nMachine S would decide A_{TM}, which cannot be. So HALT_{TM} is not decidable.';
    expect(quoteInText(String.raw`If we know that some problem (say $A _{\text{TM}}$) is undecidable`, slide)).toBe(true);
    expect(quoteInText(String.raw`Machine $S$ would decide $A _{\text{TM}}$, which cannot be. So $HALT _{\text{TM}}$ is not decidable.`, slide)).toBe(true);
    expect(normForMatch(String.raw`$\left\langle M , w \right\rangle$`)).toBe('m w');
  });
  it('rejects invented text and ignores quotes too short to mean anything', () => {
    expect(quoteInText('the halting problem is decidable', 'The halting problem is undecidable')).toBe(false);
    expect(quoteInText('NP', 'NP complete')).toBeUndefined();
    expect(quoteInText('the problem halting is', 'The halting problem is undecidable')).toBe(false); // word order matters
  });
  it('summarises source status', () => {
    expect(sourceStatus([])).toBe('none');
    expect(sourceStatus([{ lectureId: 'a', slide: 1 }])).toBe('slide-only');
    expect(sourceStatus([{ lectureId: 'a', slide: 1, verified: false }])).toBe('unverified');
    expect(sourceStatus([{ lectureId: 'a', slide: 1, verified: false }, { lectureId: 'a', slide: 2, verified: true }])).toBe('verified');
  });
});

describe('planPack', () => {
  it('rejects things that are not packs, with a reason', async () => {
    const { course, ctx } = await setup();
    expect(planPack({ hello: 1 }, course.id, [ctx]).fatal).toMatch(/StudyAI 팩이 아닙니다/);
    expect(planPack(pack({ version: 99 }), course.id, [ctx]).fatal).toMatch(/형식 버전 99/);
    expect(planPack(pack(), course.id, [ctx]).issues.some((i) => /팩에 노트, 카드, 문제가 하나도 없습니다/.test(i.message))).toBe(true);
  });

  it('matches lectures by hash, then title, then manual mapping', async () => {
    const { course, ctx } = await setup();
    const byHash = planPack(pack({ lectures: [{ ref: 'L1', title: 'Something else', fileHash: ctx.fileHash }] }), course.id, [ctx]);
    expect(byHash.lectureMap[0]).toMatchObject({ localId: ctx.id, how: 'hash' });
    const byTitle = planPack(pack({ lectures: [{ ref: 'L1', title: 'lecture 7 - undecidability' }] }), course.id, [ctx]);
    expect(byTitle.lectureMap[0]).toMatchObject({ localId: ctx.id, how: 'title' });
    const none = planPack(pack({ lectures: [{ ref: 'L1', title: 'Unknown lecture' }] }), course.id, [ctx]);
    expect(none.lectureMap[0]!.localId).toBeUndefined();
    expect(none.issues[0]!.message).toMatch(/이 과목에 “Unknown lecture”와\(과\) 일치하는 강의가 없습니다/);
    const manual = planPack(pack({ lectures: [{ ref: 'L1', title: 'Unknown lecture' }] }), course.id, [ctx], { L1: ctx.id });
    expect(manual.lectureMap[0]).toMatchObject({ localId: ctx.id, how: 'manual' });
    const stale = planPack(pack({ lectures: [{ ref: 'L1', title: 'Lecture 7 Undecidability', slideCount: 55 }] }), course.id, [ctx]);
    expect(stale.issues.some((i) => /슬라이드 번호가 어긋날 수 있으니/.test(i.message))).toBe(true);
  });

  it('accepts good items as pending/imported, checks every quote and counts sources', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'definition', front: 'Halting problem?', back: 'Decide whether a TM halts.', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The **halting problem** is undecidable' }] },
          { type: 'qa', front: 'Who showed it?', back: 'Turing, 1936.', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'Mention Turing 1936' }] },
        ],
        notes: [{ title: 'Summary', kind: 'summary', lecture: 'L1', blocks: [{ text: 'Reductions transfer decidability.', basis: 'derived', sources: [{ lecture: 'L1', slide: 2 }] }] }],
      }),
      course.id,
      [ctx],
    );
    expect(plan.fatal).toBeUndefined();
    expect(plan.stats).toMatchObject({ received: 3, accepted: 3, rejected: 0, sources: 3, verified: 2, unverified: 0 });
    expect(plan.cards).toHaveLength(2);
    expect(plan.cards.every((c) => c.status === 'pending' && c.origin === 'imported' && c.fsrs.state === 0 && c.packId === plan.packId)).toBe(true);
    expect(plan.cards[0]!.sources[0]).toMatchObject({ lectureId: ctx.id, slide: 1, verified: true, rev: 1 });
    expect(plan.notes[0]!.blocks[0]).toMatchObject({ origin: 'imported', basis: 'derived' });
    expect(plan.notes[0]!.lectureId).toBe(ctx.id);
  });

  it('flags quotes that are not on the slide and slides that do not exist', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'definition', front: 'f', back: 'b', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is easily decidable in linear time' }] },
          { type: 'definition', front: 'f2', back: 'b2', lecture: 'L1', basis: 'derived', sources: [{ lecture: 'L1', slide: 99, quote: 'whatever it said here' }] },
        ],
      }),
      course.id,
      [ctx],
    );
    expect(plan.cards[0]!.sources[0]!.verified).toBe(false);
    expect(sourceStatus(plan.cards[0]!.sources)).toBe('unverified');
    expect(plan.cards[1]!.sources).toEqual([]); // dropped: slide 99 does not exist
    const msgs = plan.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/의 1번 슬라이드에서 찾지 못했습니다/);
    expect(msgs).toMatch(/이 강의는 4장뿐이라/);
    expect(msgs).toMatch(/슬라이드에 있다고 하지만 인용문을 하나도 확인하지 못했습니다/);
    // the same problems by code, for a caller that acts on them (the command-line check), with the slide a missed quote pointed at
    expect(plan.issues.map((i) => i.code).filter(Boolean)).toEqual(['QUOTE_NOT_FOUND', 'LECTURE_CLAIM_UNVERIFIED', 'SOURCE_SLIDE_MISSING']);
    expect(plan.issues.find((i) => i.code === 'QUOTE_NOT_FOUND')!.slide).toEqual({ lectureTitle: ctx.title, number: 1 });
    expect(plan.stats.unverified).toBe(2);
  });

  it('skips invalid items individually and says why; missing basis becomes uncertain', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'nonsense', front: 'x', back: 'y' },
          { type: 'qa', front: '', back: 'y' },
          { type: 'qa', front: 'ok front', back: 'ok back', lecture: 'L1' },
        ],
        questions: [{ type: 'mcq', prompt: 'p', marks: 1, options: [{ text: 'a', correct: false }, { text: 'b', correct: false }], modelAnswer: 'x' }],
      }),
      course.id,
      [ctx],
    );
    expect(plan.stats).toMatchObject({ received: 4, accepted: 1, rejected: 3 });
    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0]!.basis).toBe('uncertain');
    const errs = plan.issues.filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errs.join('\n')).toMatch(/건너뜀/);
    expect(errs.some((m) => /정답으로 표시된 보기가 없습니다/.test(m))).toBe(true);
    expect(plan.issues.some((i) => /“basis”가 없어/.test(i.message))).toBe(true);
  });

  it('builds questions: MCQ options, true/false, rubric marks check, required answers', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        questions: [
          { type: 'mcq', prompt: 'Which is undecidable?', marks: 1, options: [{ text: 'Halting', correct: true }, { text: 'Sorting', correct: false }], basis: 'derived', sources: [] },
          { type: 'truefalse', prompt: 'HALT is decidable.', marks: 1, answer: false, basis: 'derived', sources: [] },
          { type: 'short', prompt: 'Explain reductions.', marks: 3, modelAnswer: 'ok', rubric: [{ text: 'a', marks: 1 }, { text: 'b', marks: 1 }], basis: 'derived', sources: [], lectures: ['L1'] },
          { type: 'long', prompt: 'No answer given', marks: 5, basis: 'derived', sources: [] },
        ],
      }),
      course.id,
      [ctx],
    );
    expect(plan.questions).toHaveLength(3);
    expect(plan.questions[0]!.options).toEqual([{ id: 'o1', text: 'Halting', correct: true }, { id: 'o2', text: 'Sorting', correct: false }]);
    expect(plan.questions[1]!.options!.find((o) => o.correct)!.text).toBe('거짓');
    expect(plan.questions[2]!.lectureIds).toEqual([ctx.id]);
    expect(plan.questions[2]!.rubric.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(plan.issues.some((i) => /채점 기준의 합은 2점인데 문제 배점은 3점입니다/.test(i.message))).toBe(true);
    expect(plan.issues.some((i) => /모범 답안이나 채점 기준이 있어야 합니다/.test(i.message))).toBe(true);
  });
});

describe('applying and removing a pack', () => {
  it('stores pending items, and removal deletes exactly that pack (edited items are kept)', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'qa', front: 'one', back: '1', lecture: 'L1', basis: 'derived' },
          { type: 'qa', front: 'two', back: '2', lecture: 'L1', basis: 'derived' },
        ],
        notes: [{ title: 'N', lecture: 'L1', blocks: [{ text: 't', basis: 'derived' }] }],
      }),
      course.id,
      [ctx],
    );
    const res = await applyPackPlan(db, course.id, plan);
    expect(res).toEqual({ notes: 1, cards: 2, questions: 0 });
    expect((await db.packs.get(plan.packId))!.counts).toEqual({ notes: 1, cards: 2, questions: 0 });
    expect(await db.cards.where('status').equals('pending').count()).toBe(2);

    await updateCard(db, plan.cards[0]!.id, { front: 'one (edited)' }); // detaches from the pack
    const removed = await removePack(db, plan.packId);
    expect(removed).toEqual({ notes: 1, cards: 1, questions: 0 });
    expect((await db.cards.toArray()).map((c) => c.front)).toEqual(['one (edited)']);
    expect(await db.packs.count()).toBe(0);
  });

  it('refuses to apply a failed plan', async () => {
    const { course } = await setup();
    await expect(applyPackPlan(db, course.id, planPack({}, course.id, []))).rejects.toThrow(/StudyAI 팩이 아닙니다/);
  });
});

describe('lecture export for your own AI', () => {
  it('keeps slide numbers, markdown formatting, tables, LaTeX and caveats', async () => {
    const { lecture, slides } = await setup();
    const md = lectureToMarkdown(lecture, slides, 'L1');
    expect(md).toContain('## Lecture L1: Lecture 7 Undecidability');
    expect(md).toContain(`<!-- studyai-lecture ref=L1 hash=${lecture.fileHash} slides=4 -->`);
    expect(md).toContain('### Slide 1: Halting problem');
    expect(md).toContain('- The halting problem is undecidable');
    expect(md).toContain('**Speaker notes:** Mention Turing 1936');
    expect(md).toContain('| Class | Verify | Solve |');
    expect(md).toContain('| NP | poly | unknown |');
    expect(md).toContain('$$\\frac{a}{b}$$');
  });

  it('builds a prompt that carries the rules, the format and the professor’s style', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: { notes: false, cards: true, questions: true }, examStyle: 'Answers must be 1-3 sentences.' });
    expect(p).toContain('"studyai-pack"');
    expect(p).toContain('플래시카드 25장');
    expect(p).toContain('채점 기준이 있는 시험형 문제 12개');
    expect(p).not.toContain('노트 10개');
    expect(p).toContain('강의 내용, 정의, 증명 단계, 시험 규칙, 교수가 선호하는 것을 지어내지 마세요');
    expect(p).toMatch(/quote는 항목 전체를 뒷받침해야 합니다.*절대 "lecture"가 아닙니다/s); // a true quote does not make an unsupported claim "on the slides"
    expect(p).toMatch(/자연스러운 한국어로 쓰세요.*"quote"는 슬라이드 문장을 원래 언어 그대로.*번역하지 마세요/s); // Korean for the student, the slide's own words for the evidence
    expect(p).toContain('"outside"');
    expect(p).toContain('Answers must be 1-3 sentences.');
    expect(p).toContain('"fileHash"');
  });
});

describe('asking for a pack that fits the answer limit', () => {
  const all = { notes: true, cards: true, questions: true };
  const tokens = (c: ReturnType<typeof packCounts>) => c.notes * 220 + c.cards * 130 + c.questions * 330;

  it('asks for the usual numbers when there is no answer limit', () => {
    expect(packCounts({ wants: all, amount: 'normal' })).toEqual({ notes: 10, cards: 25, questions: 12 });
    expect(packCounts({ wants: { notes: false, cards: true, questions: false }, amount: 'few' })).toEqual({ notes: 0, cards: 10, questions: 0 });
  });

  it('cuts the numbers until the pack fits well inside the limit, and never asks for a kind that was not wanted', () => {
    for (const amount of ['few', 'normal', 'many'] as const) {
      for (const wants of [all, { notes: false, cards: true, questions: true }, { notes: true, cards: false, questions: false }]) {
        const c = packCounts({ wants, amount, outputTokens: 4_000 });
        expect(tokens(c), `${amount} ${JSON.stringify(wants)}`).toBeLessThanOrEqual(0.7 * 4_000 - 150);
        expect(c.notes > 0).toBe(wants.notes);
        expect(c.cards > 0).toBe(wants.cards);
        expect(c.questions > 0).toBe(wants.questions);
      }
    }
    // the case that was cut off in a real run: a normal set of everything must not be 10 + 25 + 12 items in 4000 tokens
    const normal = packCounts({ wants: all, amount: 'normal', outputTokens: 4_000 });
    expect(normal.notes + normal.cards + normal.questions).toBeLessThan(20);
    // a small request is left alone, and a tiny limit still asks for at least one of each wanted kind
    expect(packCounts({ wants: { notes: false, cards: true, questions: false }, amount: 'few', outputTokens: 4_000 }).cards).toBe(10);
    expect(packCounts({ wants: all, amount: 'many', outputTokens: 300 })).toEqual({ notes: 1, cards: 1, questions: 1 });
  });

  it('tells the model to leave the lists it was not asked for empty (found with the real model: a questions-only request came back with a card and a note)', () => {
    expect(studyPackPrompt({ amount: 'few', wants: { notes: false, cards: false, questions: true }, outputTokens: 4_000 })).toContain('"notes"와 "cards"은(는) 빈 목록([])으로 두세요');
    expect(studyPackPrompt({ amount: 'few', wants: { notes: true, cards: false, questions: true } })).toContain('"cards"은(는) 빈 목록([])으로 두세요');
    expect(studyPackPrompt({ amount: 'few', wants: all })).not.toContain('빈 목록'); // everything asked for: nothing to leave out
    expect(studyPackPrompt({ amount: 'few', wants: { notes: false, cards: false, questions: false } })).not.toContain('빈 목록'); // nothing asked for: the generic task stays
  });

  it('puts the cut counts and a "keep it short" rule into the prompt, and the most valuable list first', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: all, outputTokens: 4_000 });
    const c = packCounts({ wants: all, amount: 'normal', outputTokens: 4_000 });
    expect(p).toContain(`플래시카드 ${c.cards}장`);
    expect(p).toContain(`시험형 문제 ${c.questions}개`);
    expect(p).not.toContain('플래시카드 25장');
    expect(p).toMatch(/약 1,400단어로 제한되며 중간에 잘리면 버려지므로/);
    expect(p).toMatch(/항목 수를 줄이고, 항목을 길게 쓰지 마세요/);
    expect(p.indexOf('"questions": [')).toBeLessThan(p.indexOf('"cards": ['));
    expect(p.indexOf('"cards": [')).toBeLessThan(p.indexOf('"notes": ['));
    expect(studyPackPrompt({ amount: 'normal', wants: all })).not.toMatch(/잘리면 버려지므로/); // the copy-and-paste prompt has no such limit
  });
});

describe('importing questions: the quality check is part of the check screen', () => {
  const goodQ = (over: Record<string, unknown> = {}) => ({
    type: 'short',
    prompt: 'Explain why the halting problem is undecidable and name the method used to show it.',
    marks: 2,
    difficulty: 2,
    topic: 'Halting problem',
    modelAnswer: 'The halting problem is undecidable, which is shown by a proof by contradiction using diagonalisation.',
    rubric: [{ text: 'The halting problem is undecidable', marks: 1 }, { text: 'The proof uses contradiction and diagonalisation', marks: 1 }],
    basis: 'lecture',
    sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is undecidable' }],
    ...over,
  });

  it('turns the checker’s findings into warnings that name the question, and keeps the set summary', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(pack({ questions: [goodQ(), goodQ({ prompt: 'Explain why the halting problem is undecidable and name the method used to show it?', marks: 6 }), goodQ({ modelAnswer: undefined })] }), course.id, [ctx]);
    expect(plan.questions).toHaveLength(3);
    expect(plan.quality?.stats).toMatchObject({ questions: 3, totalMarks: 10 });
    const messages = plan.issues.map((i) => `${i.where}: ${i.message}`);
    expect(messages.some((m) => /^문제 #2: 배점은 6점인데 채점 기준은 2개뿐입니다/.test(m))).toBe(true);
    expect(messages.some((m) => /^문제 #2: 문제 2이\(가\) 문제 1과\(와\) 거의 같습니다/.test(m))).toBe(true);
    expect(messages.some((m) => /^문제 #3: 비교할 모범 답안이 없습니다/.test(m))).toBe(true);
    expect(plan.issues.filter((i) => i.severity === 'warning' && /^문제 #1:/.test(i.where))).toEqual([]);
  });

  it('names a question by its place in the pack even when an earlier one was skipped', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(pack({ questions: [{ nonsense: true }, goodQ({ marks: 6 })] }), course.id, [ctx]);
    expect(plan.questions).toHaveLength(1);
    expect(plan.issues.some((i) => i.where === '문제 #2' && /배점은 6점인데 채점 기준은 2개뿐/.test(i.message))).toBe(true);
  });

  it('compares the questions with the plan that was asked for, and with the questions that already exist', async () => {
    const { course, ctx } = await setup();
    const expected = [{ type: 'scenario' as const, difficulty: 3 as const, marks: 6, points: 6, topic: 'Reductions', slides: [2] }];
    const plan = planPack(pack({ questions: [goodQ()] }), course.id, [ctx], {}, undefined, { expected, existingPrompts: ['Explain why the halting problem is undecidable and name the method used to show it'] });
    expect(plan.quality?.stats.asPlanned).toEqual({ met: 0, of: 1 });
    const text = plan.issues.map((i) => i.message).join(' | ');
    expect(text).toMatch(/상황 문제\(으\)로 계획했지만 단답형입니다/);
    expect(text).toMatch(/6점으로 계획했지만 배점이 2점입니다/);
    expect(text).toMatch(/주제 “Reductions”\(으\)로 계획했지만/);
    expect(text).toMatch(/이미 있는 문제와 겹칩니다/);
  });

  it('matches the plan to the place the AI wrote each question at, so skipped questions do not shift it', async () => {
    // a real model once left the "prompt" out of three of four questions: the survivor is the fourth one, and was compared with the first slot
    const { course, ctx } = await setup();
    const expected = [
      { type: 'diagram' as const, difficulty: 2 as const, marks: 3, points: 3, topic: 'First', slides: [1] },
      { type: 'attack' as const, difficulty: 3 as const, marks: 3, points: 3, topic: 'Second', slides: [1] },
      { type: 'compare' as const, difficulty: 2 as const, marks: 4, points: 4, topic: 'Third', slides: [1] },
      { type: 'short' as const, difficulty: 2 as const, marks: 2, points: 2, topic: 'Halting problem', slides: [1] },
    ];
    const noPrompt = { type: 'diagram', marks: 3, difficulty: 2, topic: 'First', modelAnswer: 'x', rubric: [{ text: 'a', marks: 3 }] };
    const plan = planPack(pack({ questions: [noPrompt, noPrompt, noPrompt, goodQ()] }), course.id, [ctx], {}, undefined, { expected });
    expect(plan.questions).toHaveLength(1);
    expect(plan.quality?.stats.asPlanned).toEqual({ met: 1, of: 4 });
    const text = plan.issues.map((i) => i.message).join(' | ');
    expect(text).not.toMatch(/\(으\)로 계획했지만/); // the survivor IS the fourth planned question
    expect(text).toMatch(/문제 4개를 계획했지만 1개가 돌아왔습니다\. 계획한 문제 1, 2, 3번은 쓸 수 있는 형태로 돌아오지 않았습니다\./);
    expect(plan.issues.filter((i) => /prompt/.test(i.message)).map((i) => i.where)).toEqual(['문제 #1', '문제 #2', '문제 #3']);
  });

  it('reads a true/false question whose "answer" field is missing from its model answer, with a warning, and still refuses one with no clear answer', async () => {
    // a real model wrote modelAnswer "True" and a one-point rubric "True" but no "answer": the question was thrown away
    const { course, ctx } = await setup();
    const tf = (over: Record<string, unknown>) => ({ type: 'truefalse', prompt: 'Is it so?', marks: 1, difficulty: 1, basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is undecidable' }], ...over });
    const plan = planPack(
      pack({
        questions: [
          tf({ modelAnswer: 'True', rubric: [{ text: 'True', marks: 1 }] }),
          tf({ modelAnswer: 'False. The slides say the opposite.', rubric: [{ text: 'False', marks: 1 }] }),
          tf({ rubric: [{ text: 'false, because the slide says so', marks: 1 }] }),
          tf({ modelAnswer: 'It depends on the input.', rubric: [{ text: 'It depends', marks: 1 }] }),
          tf({ answer: false, modelAnswer: 'True' }), // an explicit answer always wins
        ],
      }),
      course.id,
      [ctx],
    );
    expect(plan.questions.map((q) => q.options?.find((o) => o.correct)?.text)).toEqual(['참', '거짓', '거짓', '거짓']);
    expect(plan.issues.filter((i) => i.severity === 'error').map((i) => i.where)).toEqual(['문제 #4']);
    expect(plan.issues.find((i) => i.where === '문제 #4')?.message).toMatch(/"answer": true 또는 false가 있어야 합니다/);
    expect(plan.issues.filter((i) => /"answer" 항목이 없어/.test(i.message)).map((i) => i.where)).toEqual(['문제 #1', '문제 #2', '문제 #3']);
    expect(plan.issues.find((i) => i.where === '문제 #1')?.message).toMatch(/모범 답안에서 참으로 읽었습니다/);
  });

  it('names a marking point that nobody asked for, and a badly formed "ask" never costs the whole question', async () => {
    const { course, ctx } = await setup();
    const asked = goodQ({
      marks: 3,
      prompt: 'Explain why the halting problem is undecidable and name the method used to show it, and state one consequence.',
      asks: [{ quote: 'Explain why the halting problem is undecidable', count: 1 }, { quote: 'name the method used to show it', count: 1 }],
      rubric: [{ text: 'The halting problem is undecidable', marks: 1, ask: 1 }, { text: 'The proof uses contradiction and diagonalisation', marks: 1, ask: 2 }, { text: 'Rice theorem generalises the result', marks: 1, ask: 2 }],
    });
    const sloppy = goodQ({ asks: 'yes please', rubric: [{ text: 'The halting problem is undecidable', marks: 1, ask: '1' }, { text: 'The proof uses contradiction and diagonalisation', marks: 1, ask: 1.5 }] });
    const plan = planPack(pack({ questions: [asked, sloppy] }), course.id, [ctx], {}, undefined, { expected: [{ type: 'short' as const, difficulty: 2 as const, marks: 3, points: 3, topic: 'Halting problem', slides: [1] }, { type: 'short' as const, difficulty: 2 as const, marks: 2, points: 2, topic: 'Halting problem', slides: [1] }] });
    expect(plan.questions).toHaveLength(2); // neither question is dropped
    const messages = plan.issues.filter((i) => i.severity === 'warning').map((i) => `${i.where}: ${i.message}`);
    expect(messages.some((m) => /^문제 #1: 문제는 "name the method used to show it"에서 1개를 요구하지만 이에 답하는 채점 기준은 2개입니다\. 남는 점수는 문제에서 요구하지 않은 것입니다/.test(m))).toBe(true);
    expect(messages.some((m) => /^문제 #2: 각 채점 기준이 문제의 어느 부분에 답하는지 밝히지 않아/.test(m))).toBe(true); // the unreadable asks were ignored
  });

  it('adds nothing for a pack without questions', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(pack({ cards: [{ type: 'qa', front: 'q', back: 'a', basis: 'derived' }] }), course.id, [ctx]);
    expect(plan.quality).toBeUndefined();
  });
});

describe('asking for planned, good exam questions', () => {
  const plan = [
    { type: 'scenario' as const, difficulty: 3 as const, marks: 6, points: 6, topic: 'Defences', slides: [4, 5] },
    { type: 'truefalse' as const, difficulty: 1 as const, marks: 1, points: 1, topic: 'Threats', slides: [2] },
    { type: 'compare' as const, difficulty: 2 as const, marks: 4, points: 4, topic: 'Policies', slides: [7] },
  ];
  const q = { notes: false, cards: false, questions: true };

  it('lists the planned questions with type, difficulty, marks, number of marking points, topic and slides, in order', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, outputTokens: 4_000, blueprint: plan });
    expect(p).toContain('작성할 문제: 정확히 3개, 이 순서대로');
    expect(p).toContain('1. type "scenario", 난이도 3, 6점, 채점 기준 6개, 주제 "Defences", 근거 슬라이드 4, 5');
    expect(p).toContain('2. type "truefalse", 난이도 1, 1점, 채점 기준 1개, 주제 "Threats", 근거 슬라이드 2');
    expect(p).toContain('3. type "compare", 난이도 2, 4점, 채점 기준 4개, 주제 "Policies", 근거 슬라이드 7');
    expect(p).toContain('채점 기준이 있는 시험 문제 3개(아래 목록)');
    expect(p).not.toContain('시험형 문제 12개'); // the generic count is replaced by the plan
  });

  it('carries the rules for what a good question is: the kinds, the difficulty meaning, marks, independent points, full-marks answers, variety', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, blueprint: plan });
    expect(p).toMatch(/A\. 유형\..*scenario: 짧은 가상 상황.*모든 채점 기준은 슬라이드에 있어야 합니다/s);
    expect(p).toMatch(/B\. 난이도\. 1 = 슬라이드 하나의 개념 하나를 말하거나 알아보기\. 2 = .* 3 = 여러 슬라이드나 여러 단계가 필요해서/s);
    expect(p).toMatch(/C\. 배점\. 1점에 독립된 내용 하나 정도/);
    expect(p).toMatch(/D\. 채점 기준\. 각 기준은 학생이 따로 받을 수 있는 내용 하나입니다.*"다음 중 두 가지", "모두", "적어도", "A 또는 B"를 기준으로 쓰지 말고/s);
    expect(p).toMatch(/E\. 모범 답안\. 만점을 받는 학생이 쓰는 답입니다.*슬라이드를 벗어나는 내용은 넣지 마세요/s);
    expect(p).toMatch(/F\. 다양성.*<already_asked>/s);
    // every kind of question is explained
    for (const kind of ['define', 'short', 'compare', 'scenario', 'case', 'attack', 'problem, calculation', 'proof', 'algorithm, programming', 'diagram', 'mcq', 'long']) expect(p, kind).toContain(`- ${kind}:`);
  });

  it('insists that every question carries its own text (a real model left it out of three of four)', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, outputTokens: 4_000, blueprint: plan });
    expect(p).toMatch(/G\. 문제 문장\. 모든 문제에는 "prompt"가 있어야 합니다\. 학생이 읽는 문제 전문이며.*버려집니다/s);
    expect(p).toMatch(/위 줄은 무엇을 쓸지 알려 줄 뿐 문제 자체가 아닙니다\. 학생이 읽을 문장은 각 문제의 "prompt"에 쓰세요/);
    expect(p).toContain('"prompt": "필수. 학생이 읽는 문제 전문');
    expect(p).toContain('(항상 "answer": true 또는 false를 쓰세요)'); // a real model wrote "True" in the model answer and left the field out twice
    expect(p).toContain('"expectedWords"는 [8 x 배점, 14 x 배점]으로 정하세요. 3점 문제는 [24, 42]입니다.'); // a real model copied [12, 20] for a 3-mark question
  });

  it('makes every marking point answer something the question asks, and every scenario need its situation', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, outputTokens: 4_000, blueprint: plan });
    expect(p).toMatch(/H\. 요구 사항\. prompt 다음에 학생에게 요구하는 것을 하나하나 "asks"에 나열합니다.*prompt 속 문구 그대로.*"count".*첫째 요구 사항이면 "ask": 1/s);
    expect(p).toMatch(/count가 3인 요구 사항에는 채점 기준이 정확히 세 개 있고.*count의 합은 배점과 같습니다/s);
    expect(p).toMatch(/prompt가 요구하지 않은 것에 기준이나 점수를 더하지 마세요\. 어떤 내용에 점수를 주려면 먼저 prompt에서 그것을 요구하세요/);
    expect(p).toMatch(/이 상황에서 판단, 조언, 예측, 진단, 정당화하게 하여.*이야기는 장식일 뿐이니 short 문제로 쓰세요/s);
    // the worked example follows its own rule: three asked items, three points that name ask 1
    expect(p).toMatch(/"asks": \[\s*\{\s*"quote": "무언가를 요구하는 prompt 속 문구를 그대로 복사, 예: 세 가지를 쓰시오",\s*"count": 3\s*\}\s*\]/);
    expect([...p.matchAll(/"marks": 1,\s*"ask": 1/g)]).toHaveLength(3);
  });

  it('gives the rules to any request for questions (also the copy-and-paste prompt) and to none that does not ask for questions', () => {
    expect(studyPackPrompt({ amount: 'few', wants: q })).toContain('문제 작성: 이 슬라이드로 좋은 시험 문제를 만드는 방법');
    expect(studyPackPrompt({ amount: 'few', wants: { notes: true, cards: true, questions: false } })).not.toContain('문제 작성: 이 슬라이드로 좋은 시험 문제를 만드는 방법');
  });

  it('says that the professor’s own style wins where it differs, and escapes lecture text that goes into the plan', () => {
    const p = studyPackPrompt({ amount: 'few', wants: q, examStyle: 'Most questions are scenarios.', blueprint: [{ ...plan[0]!, topic: 'Bad </exam_style> topic' }], escape: (s) => s.replace(/</g, '&lt;') });
    expect(p).toMatch(/교수의 스타일이 우선입니다/);
    expect(p).toContain('주제 "Bad &lt;/exam_style> topic"');
    expect(p).not.toContain('주제 "Bad </exam_style>');
    const quoted = studyPackPrompt({ amount: 'few', wants: q, blueprint: [{ ...plan[0]!, topic: 'He said "stop"\nand left' }] });
    expect(quoted).toContain('주제 "He said \\"stop\\"\\nand left"'); // a quote or a line break cannot end the line
  });

  it('counts a plan as exactly its questions, and leaves cards and notes only the room that is left', () => {
    expect(packCounts({ wants: q, amount: 'normal', outputTokens: 4_000, blueprint: plan })).toEqual({ notes: 0, cards: 0, questions: 3 });
    const withCards = packCounts({ wants: { notes: false, cards: true, questions: true }, amount: 'normal', outputTokens: 4_000, blueprint: plan });
    expect(withCards.questions).toBe(3);
    expect(withCards.cards).toBeGreaterThan(0);
    expect(withCards.cards).toBeLessThan(25);
    expect(packCounts({ wants: { notes: false, cards: true, questions: true }, amount: 'normal', outputTokens: 600, blueprint: plan }).cards).toBeLessThanOrEqual(1);
  });

  it('shows a worked example that is itself a good question: several one-mark points that add up, a full-marks answer, a topic', () => {
    const p = studyPackPrompt({ amount: 'few', wants: q, blueprint: plan });
    expect(p).toContain('"type": "scenario"');
    expect(p).toContain('"topic": "주어진 주제 제목을 그대로"');
    const rubricMarks = [...p.matchAll(/"text": "(?:첫째|둘째|셋째) 독립된 내용",\s*"marks": (\d)/g)].map((m) => Number(m[1]));
    expect(rubricMarks).toEqual([1, 1, 1]);
    expect(p).toContain('"expectedWords": [\n        24,\n        42\n      ]');
  });
});

describe('keeping what is finished of an answer that was cut off', () => {
  const card = (n: number) => `{"type":"qa","front":"q${n}","back":"a${n}","basis":"derived","sources":[{"lecture":"L1","slide":1,"quote":"The halting problem is undecidable"}]}`;
  const head = '{"format":"studyai-pack","version":1,"lectures":[{"ref":"L1","title":"Computability"}],"questions":[{"type":"truefalse","prompt":"p","marks":1,"answer":true}],"cards":[';

  it('keeps every complete item and drops only the unfinished one', () => {
    const cut = `${head}${card(1)},${card(2)},{"type":"qa","front":"q3","back":"an answ`;
    const r = recoverTruncatedJson(cut)!;
    expect(r.items).toBe(3); // one question and two cards
    const v = r.value as { cards: { front: string }[]; questions: unknown[] };
    expect(v.cards.map((c) => c.front)).toEqual(['q1', 'q2']);
    expect(v.questions).toHaveLength(1);
    expect(() => extractJson(cut)).toThrow(); // the ordinary reader gives up on the same text
  });

  it('copes with a code fence that was never closed, with braces and escaped quotes inside strings, and with a cut right after a comma', () => {
    const tricky = '{"type":"qa","front":"What does \\"}\\" close in {a, b}? \\\\","back":"a closing brace ] }","basis":"derived"}';
    const text = '```json\n' + head + `${tricky},${card(2)},`;
    const r = recoverTruncatedJson(text)!;
    expect((r.value as { cards: { front: string }[] }).cards).toHaveLength(2);
    expect((r.value as { cards: { front: string }[] }).cards[0]!.front).toBe('What does "}" close in {a, b}? \\');
  });

  it('keeps a pack that was cut after a whole list, and gives up when not even one item was finished', () => {
    const afterCards = `${head}${card(1)}],"notes":[{"title":"Summary","blocks":[{"text":"half a no`;
    expect((recoverTruncatedJson(afterCards)!.value as { cards: unknown[]; notes?: unknown[] }).cards).toHaveLength(1);
    expect(recoverTruncatedJson('{"format":"studyai-pack","version":1,"cards":[{"type":"qa","front":"unfini')).toBeUndefined();
    expect(recoverTruncatedJson('no json at all')).toBeUndefined();
    expect(recoverTruncatedJson('[1,2,3')).toBeUndefined();
  });

  it('is fast on a very long cut-off answer', () => {
    const many = `${head}${Array.from({ length: 4_000 }, (_, i) => card(i)).join(',')},{"type":"qa","fr`;
    const t0 = Date.now();
    expect((recoverTruncatedJson(many)!.value as { cards: unknown[] }).cards).toHaveLength(4_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('backup of learning-engine data', () => {
  it('round-trips cards, notes, questions, reviews, packs and activity', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [{ type: 'qa', front: 'q', back: 'a', lecture: 'L1', basis: 'derived' }],
        notes: [{ title: 'N', lecture: 'L1', blocks: [{ text: 't', basis: 'derived' }] }],
        questions: [{ type: 'truefalse', prompt: 'p', marks: 1, answer: true, basis: 'derived' }],
      }),
      course.id,
      [ctx],
    );
    await applyPackPlan(db, course.id, plan);
    await db.activity.add({ at: 1_700_000_000_000, kind: 'slides', courseId: course.id, count: 3 });
    await db.reviews.add({ id: 'r1', cardId: plan.cards[0]!.id, courseId: course.id, at: 1_700_000_000_000, rating: 3, stateBefore: 0, durationMs: 1200 });

    const bytes = new Uint8Array(await (await exportBackup(db)).arrayBuffer());
    const parsed = readBackup(bytes);
    expect(parsed.manifest.version).toBe(BACKUP_VERSION);
    const fresh = new StudyDB(`pk-r-${n++}`);
    const summary = await applyBackup(fresh, parsed, 'replace');
    expect(summary.studyRows).toBeGreaterThanOrEqual(6);
    for (const t of ['cards', 'notes', 'questions', 'reviews', 'packs', 'activity'] as const) {
      expect(await fresh.table(t).toArray(), t).toEqual(await db.table(t).toArray());
    }
  });

  it('still reads version-1 backups (no study tables)', async () => {
    const { course } = await setup();
    void course;
    const bytes = new Uint8Array(await (await exportBackup(db)).arrayBuffer());
    const parsed = readBackup(bytes);
    expect(parsed.study.cards ?? []).toEqual([]);
  });
});
