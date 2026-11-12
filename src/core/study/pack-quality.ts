import { joinScripts } from './match';
import { isQuestionText } from './slide-questions';
import type { PlannedSlot } from './blueprint';
import { QUESTION_TYPE_LABEL, type QuestionType } from './types';

/**
 * A check of generated exam questions that needs no AI: the same rules the model is given (pack-format.ts), applied to what
 * came back. It cannot judge whether a question is wise, but it finds the faults that make an exam bad or unfair to mark: marking
 * points that overlap or are not independent, marks that do not match the work, a model answer that would not earn full marks,
 * points that are not on the slides cited, duplicates, a set that is all recall, and questions that ignore the plan.
 *
 * Everything here is advice shown before the student approves anything; nothing is changed or dropped.
 */

export interface QualityQuestion {
  type: QuestionType;
  prompt: string;
  marks: number;
  difficulty: number;
  topic?: string | undefined;
  rubric: { text: string; marks: number; keywords?: string[] | undefined; /** The number (1 = first) of the ask this point answers. */ ask?: number | undefined }[];
  /** The separate things the prompt asks for, in the model's own listing: the words of the prompt and how many items each wants. */
  asks?: { quote: string; count: number }[] | undefined;
  modelAnswer?: string | undefined;
  options?: { correct: boolean }[] | undefined;
  sources: { lectureId: string; slide: number }[];
}

export type QualityCode =
  | 'NO_RUBRIC'
  | 'POINTS_FEW'
  | 'POINTS_MANY'
  | 'POINT_BUNDLE'
  | 'POINTS_OVERLAP'
  | 'POINTS_NOT_INDEPENDENT'
  | 'POINT_EITHER'
  | 'NO_MODEL_ANSWER'
  | 'ANSWER_MISSES_POINT'
  | 'ANSWER_THIN'
  | 'ANSWER_LONG'
  | 'POINT_NOT_ON_SLIDES'
  | 'SOURCE_IS_QUESTION'
  | 'NO_ASKS'
  | 'ASK_NOT_IN_QUESTION'
  | 'ASK_COUNT'
  | 'POINT_NOT_ASKED'
  | 'SCENARIO_NOT_NEEDED'
  | 'SCENARIO_ADDS_NOTHING'
  | 'POINTS_SAME_STEP'
  | 'TYPE_MISMATCH'
  | 'DIFFICULTY_MARKS'
  | 'DUPLICATE'
  | 'ONLY_RECALL'
  | 'ONE_DIFFICULTY'
  | 'NO_HARD'
  | 'ONE_TYPE'
  | 'PLAN_COUNT'
  | 'PLAN_TYPE'
  | 'PLAN_MARKS'
  | 'PLAN_TOPIC';

export interface QualityIssue {
  code: QualityCode;
  /** 1-based position of the question in the list; undefined for a fault of the whole set. */
  question?: number;
  /** 1-based marking point the finding is about, when it is about one (so the screen can offer to remove it). */
  point?: number;
  message: string;
}

export interface QualityStats {
  questions: number;
  byType: Partial<Record<QuestionType, number>>;
  byDifficulty: Record<1 | 2 | 3, number>;
  totalMarks: number;
  /** Share of questions that only ask to recall or state something (define, short, true/false, multiple choice). */
  recallShare: number;
  /** The slides the questions cite, as "lectureId:slide". */
  slidesCited: string[];
  /** How many of the plan's questions came back as planned (type, marks and topic), when there was a plan. */
  asPlanned?: { met: number; of: number };
}

export interface QualityReport {
  issues: QualityIssue[];
  stats: QualityStats;
}

export interface QualityContext {
  /** Plain text of a slide of a lecture (title and body), or undefined when it does not exist. */
  slideText(lectureId: string, slide: number): string | undefined;
}

export interface QualityOptions {
  expected?: readonly PlannedSlot[] | undefined;
  /** Prompts of questions that already exist, so a repeat is found. */
  existingPrompts?: readonly string[] | undefined;
  /**
   * Where each question sat in the list the AI wrote (0-based). Needed when some items were skipped as unusable: the plan is
   * matched to the position the AI wrote a question at, not to its place among the survivors.
   */
  positions?: readonly number[] | undefined;
  /** The questions were written under the rule that every marking point names the ask it answers: a question with no asks is reported. */
  requireAsks?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STOP = new Set(
  'a an the and or of to in on at by for from with without as is are was were be been being it its this that these those their there then than so such not no nor but if when while which who whom whose what why how can could should would may might must will shall do does did done has have had having into onto over under about above below between among also only each both any all more most less least very much many some other another same own per via use used using student students answer answers write writes written question state states list lists explain explains describe describes give gives identify mention mentions point points'.split(' '),
);

const KO_STOP = new Set('그리고 또는 혹은 및 등 것 수 있다 없다 하다 이다 대한 대해 위한 위해 같은 다음 무엇 어떻게 어떤 무엇인가 학생 답안 문제 쓰시오 서술하시오 설명하시오 제시하시오 나열하시오 정의하시오 각각 모두 이 그 저'.split(' '));
/** Korean particles and endings, longest first: "기계는" and "기계를" are both the word "기계". */
const KO_SUFFIXES = ['에서는', '으로는', '이라는', '에게서', '입니다', '합니다', '에서', '에게', '으로', '이라', '라는', '이며', '이고', '이다', '한다', '하는', '하고', '하여', '해서', '하면', '했다', '된다', '되는', '되어', '까지', '부터', '처럼', '보다', '마다', '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '로', '도', '만', '한', '된', '할', '함', '들'];
const HANGUL = /[가-힣]/;
const isHangulWord = (w: string): boolean => HANGUL.test(w);
/** Shortest length of a word worth comparing: Korean words of two syllables carry as much as English words of five letters. */
const tooShort = (w: string): boolean => !/^\d+$/.test(w) && w.length < (isHangulWord(w) ? 2 : 3);

/** Light stem so "overwrites" and "overwriting" match: lower case, plural and common endings removed. */
function stem(w: string): string {
  if (isHangulWord(w)) {
    const suffix = KO_SUFFIXES.find((x) => w.endsWith(x) && w.length - x.length >= 2);
    return suffix ? w.slice(0, -suffix.length) : w;
  }
  let s = w.toLowerCase();
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 's']) {
    // "address" keeps its double s: only a plural s is taken off
    if (s.length > suffix.length + 3 && s.endsWith(suffix) && !(suffix === 's' && s.endsWith('ss'))) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  return s;
}

/** The meaningful words of a text, stemmed, without repeats. */
export function keyWords(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    // numbers count even when short: "42" is the whole point of a calculation step
    if (tooShort(w) || STOP.has(w) || KO_STOP.has(w)) continue;
    const s = stem(w);
    if (!KO_STOP.has(s)) out.add(s);
  }
  return [...out];
}

/** Whether a text is written mostly in Korean. Word-count limits are lower for it: one Korean word carries a particle and often a verb ending. */
const isKoreanText = (s: string): boolean => (s.match(/[가-힣]/g) ?? []).length > (s.match(/[A-Za-z]/g) ?? []).length;

const wordCount = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Whether the words of `quote` are (almost all) in `text`: a quote the AI gave really is in the question. */
export function quoteIsIn(quote: string, text: string): boolean {
  const kw = keyWords(quote);
  return kw.length >= 2 && coverage(kw, new Set(keyWords(text))) >= 0.75;
}

/** Whether `word` (stemmed) is in `haystack` (stemmed words), allowing the same first five letters. */
function has(word: string, haystack: ReadonlySet<string>): boolean {
  if (haystack.has(word)) return true;
  if (isHangulWord(word)) {
    for (const h of haystack) if (h.length >= 2 && (h.startsWith(word) || word.startsWith(h))) return true;
    return false;
  }
  if (word.length < 5) return false;
  const p = word.slice(0, 5);
  for (const h of haystack) if (h.length >= 5 && h.startsWith(p)) return true;
  return false;
}

function coverage(words: readonly string[], haystack: ReadonlySet<string>): number {
  if (words.length === 0) return 1;
  return words.filter((w) => has(w, haystack)).length / words.length;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const containment = (small: readonly string[], big: readonly string[]): number => {
  const sb = new Set(big);
  return small.length === 0 ? 0 : small.filter((x) => sb.has(x)).length / small.length;
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const OBJECTIVE = new Set<QuestionType>(['mcq', 'truefalse']);
export const RECALL_TYPES = new Set<QuestionType>(['define', 'short', 'truefalse', 'mcq']);

/** A marking point that says "any two of …", "all four …" or "at least …" cannot be earned on its own. */
// Mark-scheme phrasing only: at the start ("Any two of…"), after the verb that lists ("Lists any 2 controls"), or followed by "of". A
// statement of the subject ("the string contains at least one 0", "through any two points") is not an instruction to the marker.
const COUNT = 'one|two|three|four|five|six|\\d+';
const CONDITIONAL = new RegExp(
  `^\\s*(?:any|at least|up to)\\s+(?:${COUNT})\\b|\\b(?:lists?|names?|gives?|states?|identif(?:y|ies)|mentions?|includes?|describes?|outlines?|any)\\s+(?:any|at least|up to)\\s+(?:${COUNT})\\b|\\b(?:any|at least|up to)\\s+(?:${COUNT})\\s+of\\b|\\ball\\s+(?:of\\s+)?(?:the\\s+)?(?:two|three|four|five|six|\\d+|above|following)\\b|\\bone of the following\\b`,
  'i',
);
/** The same mark-scheme phrasing in Korean: "다음 중 두 가지", "적어도 한 가지", "모두 언급". */
const KO_COUNT = '한|두|세|네|다섯|여섯|\\d+';
const CONDITIONAL_KO = new RegExp(`(?:중|가운데)\\s*(?:아무|임의의)?\\s*(?:${KO_COUNT})\\s*(?:가지|개)|(?:적어도|최소|최대)\\s*(?:${KO_COUNT})\\s*(?:가지|개)|다음 중 하나|(?:모두|전부)\\s*(?:언급|제시|서술|나열)`);

/**
 * "Mentions A or B": a mark-scheme instruction that lets either alone earn the mark. Only this phrasing is reported: an idea
 * that is itself a pair ("the same value can be data or an instruction") is not a choice of answers.
 */
const EITHER = /^\s*(?:mentions?|identifies?|states?|names?|gives?|lists?|notes?|includes?|refers? to|says?|describes?)\b[^.]*\b(?:or|and\/or)\b/i;
const EITHER_KO = /(?:또는|혹은)[^.]*(?:언급|제시|씀|쓴다|말함|든다|포함|서술)\S*\s*\.?$/;

/** A number written in digits or in words ("10 users", "ten users"). */
const hasNumber = (s: string): boolean => /\d/.test(s) || /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|half|double|triple)\b/i.test(s) || /(?:하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|스물|절반|두 배|세 배)/.test(s);

const enoughWords = (s: string, english: number): boolean => wordCount(s) >= (isKoreanText(s) ? Math.round(english * 0.6) : english);

const TYPE_CHECKS: Partial<Record<QuestionType, { test: (q: QualityQuestion) => boolean; message: string }>> = {
  scenario: { test: (q) => enoughWords(q.prompt, 25), message: '상황 문제는 질문하기 전에 상황을 몇 문장으로 설명해야 합니다.' },
  case: { test: (q) => enoughWords(q.prompt, 30), message: '사례 연구 문제는 소문항을 묻기 전에 사례를 여러 문장으로 설명해야 합니다.' },
  compare: { test: (q) => /compar|contrast|differ|similar|versus|\bvs\b|distinguish|both|whereas|비교|대조|차이|공통점|다른 점|같은 점|구별/i.test(q.prompt), message: '비교 문제는 비교하거나 대조하라고 물어야 합니다.' },
  calculation: { test: (q) => hasNumber(q.prompt), message: '계산 문제는 문제 안에 필요한 수치를 주어야 합니다.' },
  problem: { test: (q) => hasNumber(q.prompt) || enoughWords(q.prompt, 20), message: '문제 해결 문제는 주어진 조건과 함께 문제를 제시해야 합니다.' },
  proof: { test: (q) => /prove|\bproofs?\b|proving|show that|justify|derive|demonstrate|argue|why|증명|보이시오|보여라|정당화|유도|논증|왜|이유/i.test(q.prompt), message: '증명 문제는 무언가를 증명하거나 보이거나 정당화하라고 물어야 합니다.' },
  diagram: { test: (q) => /diagram|figure|picture|shown|illustrat|layout|drawing|chart|map|도식|그림|다이어그램|도표|차트|그래프|나타낸/i.test(q.prompt), message: '도식 해석 문제는 다루는 도식이나 그림을 언급해야 합니다.' },
  attack: { test: (q) => /defen[cs]e|countermeasure|mitigat|prevent|protect|safeguard|stop(?:s|ped|ping)?\b|detect|guard against|reduce the (?:risk|impact)|secure|harden|방어|대응|완화|예방|막|보호|탐지|위험을 줄|강화/i.test(q.prompt), message: '공격 문제는 공격이 어떻게 동작하는지만이 아니라 무엇이 공격을 약화하거나 막는지(방어나 대응책)를 물어야 합니다.' },
};

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 하나: 1, 둘: 2, 셋: 3, 넷: 4 };
/** Korean numbers that count only when a counter follows them ("세 가지", "두 개"): "한" and "세" are also ordinary words. */
const KO_NUMBER_BEFORE_COUNTER: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const KO_COUNTER = /^(?:가지|개|단계|요소|이유|점|명|종류|특징|부분)/;

/** A number after one of these counts the things being talked about ("how do these two segments grow"), not the items the question wants, unless each of them is asked about ("for each of these three types"). */
const NOT_A_COUNT_AFTER = new Set(['the', 'these', 'those', 'both', 'of', 'between', 'its', 'their', 'this', 'that', 'all', 'any', 'to', 'with', 'for']);

/** The one number a phrase asks for ("three reasons" is 3). Undefined when it names none or several. */
function numberIn(text: string): number | undefined {
  const found = new Set<number>();
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  words.forEach((w, i) => {
    const attached = /^(\d{1,2})(?:가지|개|단계|요소|점|명|종류)/.exec(w);
    if (attached) return void found.add(Number(attached[1]));
    if (w in KO_NUMBER_BEFORE_COUNTER && KO_COUNTER.test(words[i + 1] ?? '')) return void found.add(KO_NUMBER_BEFORE_COUNTER[w]!);
    if (!(w in NUMBER_WORDS) && !/^\d{1,2}$/.test(w)) return;
    if (NOT_A_COUNT_AFTER.has(words[i - 1] ?? '') && !words.slice(Math.max(0, i - 4), i).some((x) => x === 'each' || x === 'every' || x === '각' || x === '각각')) return;
    found.add(NUMBER_WORDS[w] ?? Number(w));
  });
  return found.size === 1 ? [...found][0] : undefined;
}

const sentencesOf = (s: string): string[] => s.replace(/\s+/g, ' ').split(/(?<=[.?!:])\s+(?=[A-Z("“가-힣])/).map((x) => x.trim()).filter(Boolean);
/** Verbs that only ask to state something. */
const STATE_VERB = /\b(identify|state|list|name|define|give|outline|mention|describe|write down)\b|(?:쓰시오|나열하|정의하|기술하|서술하|제시하|열거하|적으시오|무엇인가)/i;
/** Verbs that ask the student to do something with a situation. */
const APPLY_VERB = /\b(apply|decide|recommend|advise|justify|predict|diagnose|propose|choose|evaluate|assess|suggest|design|prioriti[sz]e|what (would|should|will|might|could)|how (would|should|could|might)|which\b[^.?]*\b(should|would|is best)|why (did|would|might|should))\b|(?:적용하|판단하|결정하|추천하|권고하|조언하|정당화하|예측하|진단하|제안하|선택하|평가하|설계하|우선순위|어떻게 해야|어떻게 하겠|무엇을 해야)/i;
/** Words that point back at the situation: "this", "these", "their", "they". */
const POINTS_BACK = /\b(this|these|that|those|their|they|them|its|he|she|his|her)\b|(?:^|\s)(?:이|그|해당|위|이러한|그러한)\s|이 상황|이 경우|위 상황|그들/i;

/**
 * A scenario, case or attack question whose situation changes nothing: the question only asks to state facts and does not mention
 * the situation's actor or anything in it, so the story could be deleted without changing the answer. That is a recall question.
 */
export function scenarioNotNeeded(prompt: string): boolean {
  const sentences = sentencesOf(prompt);
  const asking = sentences.filter((s) => STATE_VERB.test(s) || APPLY_VERB.test(s) || s.endsWith('?'));
  const situation = sentences.filter((s) => !asking.includes(s));
  if (asking.length === 0 || situation.length === 0) return false;
  const ask = asking.join(' ');
  if (APPLY_VERB.test(ask) || POINTS_BACK.test(ask.replace(/^\W*based on\b[^,]*,/i, ''))) return false;
  // the actor of the situation ("A developer is …", "The hospital wants …") named again in the question
  const actor = /^(?:an?|the|one)\s+((?:[\p{L}-]+\s+){0,2}?[\p{L}-]+)\s+(?:is|are|was|were|has|have|had|wants?|claims?|runs?|manages?|needs?|receives?|writes?|notices?|finds?|works?|plans?|builds?|uses?|operates?)\b/iu.exec(situation[0]!);
  const actorWords = actor ? keyWords(actor[1]!) : [];
  const askWords = new Set(keyWords(ask));
  if (actorWords.some((w) => has(w, askWords))) return false;
  return STATE_VERB.test(ask);
}

/** Words that set a situation up without telling anything about it ("suppose you have…", "you are designing…"). */
const SETUP_WORDS = new Set(
  'you your we our us someone somebody suppose assume imagine consider given want wants wanted need needs try trying tries prove proving show showing demonstrate establish construct build building create design designing designed implement'.split(' ').map((w) => stem(w)),
);

/**
 * A scenario whose situation tells the student nothing the slides do not already say, and whose question only asks to state or
 * describe: "You are designing a machine D … Suppose you have a machine H … Describe the construction of D" is the slide's own
 * construction with a sentence in front. A real situation brings something new (a person, a language, a string, a number, a
 * claim) for the slides' ideas to be applied to.
 */
export function scenarioAddsNothing(prompt: string, slideWords: ReadonlySet<string>): boolean {
  const sentences = sentencesOf(prompt);
  const asking = sentences.filter((s) => STATE_VERB.test(s) || APPLY_VERB.test(s) || s.endsWith('?'));
  const situation = sentences.filter((s) => !asking.includes(s)).join(' ');
  if (asking.length === 0 || situation === '') return false;
  if (APPLY_VERB.test(asking.join(' ')) || asking.some((s) => s.endsWith('?'))) return false; // it asks the student to decide something
  const words = keyWords(joinScripts(situation)).filter((w) => !SETUP_WORDS.has(w));
  if (words.length < 2) return false; // too little to judge
  return words.every((w) => has(w, slideWords));
}

/** The meaningful words of a step, with a subscript joined and a name like "M1" or "q0" kept (two characters with a digit are a name, not a word). */
function stepKeys(text: string): string[] {
  const out = new Set<string>();
  for (const w of joinScripts(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if ((!/\d/.test(w) && tooShort(w)) || STOP.has(w) || KO_STOP.has(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

/** The separate steps of a slide's text: its lines and sentences without their numbers or bullets. */
export function stepsOf(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').split(/(?<=[.;])\s+/))
    .map((s) => s.trim())
    .filter((s) => stepKeys(s).length >= 2);
}

/** Faults of one question. `slideWords` are the words on the slides it cites (plus its own prompt); `slideOnly` and `steps` come from the slides alone. */
function checkQuestion(q: QualityQuestion, n: number, slideWords: ReadonlySet<string> | undefined, requireAsks: boolean, slideOnly?: ReadonlySet<string>, steps: readonly string[] = []): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const add = (code: QualityCode, message: string, point?: number) => issues.push({ code, question: n, ...(point ? { point } : {}), message });
  const written = !OBJECTIVE.has(q.type);

  const check = TYPE_CHECKS[q.type];
  if (check && !check.test(q)) add('TYPE_MISMATCH', check.message);
  if (written && ((q.difficulty >= 3 && q.marks <= 2) || (q.difficulty <= 1 && q.marks >= 5))) {
    add('DIFFICULTY_MARKS', `난이도는 ${q.difficulty}인데 배점은 ${q.marks}점입니다. 난이도와 배점이 서로 맞지 않습니다.`);
  }
  if (!written) return issues;

  const points = q.rubric;
  if (points.length === 0) add('NO_RUBRIC', '채점 기준이 없어 모범 답안과 비교해서만 채점할 수 있습니다.');
  else {
    if (q.marks / points.length > 2) add('POINTS_FEW', `배점은 ${q.marks}점인데 채점 기준은 ${points.length}개뿐입니다. 기준 하나가 1점 정도가 되도록 서로 다른 내용을 나눠 적으세요.`);
    if (points.length > 2 * q.marks + 1) add('POINTS_MANY', `배점은 ${q.marks}점인데 채점 기준이 ${points.length}개입니다. 배점에 비해 요구하는 내용이 너무 많습니다.`);
    points.forEach((p, i) => {
      if (p.marks > 2 && q.type !== 'proof' && q.type !== 'calculation' && q.type !== 'problem') add('POINT_BUNDLE', `채점 기준 ${i + 1}의 배점이 ${p.marks}점입니다. 여러 내용을 묶었을 가능성이 큽니다. 내용마다 따로 점수를 받도록 나누세요.`);
      if (CONDITIONAL.test(p.text) || CONDITIONAL_KO.test(p.text)) add('POINTS_NOT_INDEPENDENT', `채점 기준 ${i + 1}이(가) 조건부입니다("${p.text.slice(0, 50)}…"). 기준은 "다음 중 두 가지"나 "모두"가 아니라 각각 독립된 내용이어야 합니다.`);
      else if ((EITHER.test(p.text) || EITHER_KO.test(p.text)) && wordCount(p.text) <= 16) add('POINT_EITHER', `채점 기준 ${i + 1}이(가) 두 내용 중 하나만 써도 인정합니다("${p.text.slice(0, 50)}…"). 점수를 받는 내용 하나를 정하거나 기준 두 개로 나누세요.`);
    });
    const words = points.map((p) => keyWords(p.text));
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = words[i]!;
        const b = words[j]!;
        const small = a.length <= b.length ? a : b;
        const big = a.length <= b.length ? b : a;
        // Conservative on purpose: "stack grows high to low" and "heap grows low to high" share most of their words and are two
        // different ideas. Only near-identical points, or one wholly inside the other, are reported.
        if ((a.length >= 3 && b.length >= 3 && jaccard(a, b) >= 0.75) || (small.length >= 3 && containment(small, big) >= 0.99 && big.length <= small.length + 2)) {
          add('POINTS_OVERLAP', `채점 기준 ${i + 1}과(와) ${j + 1}이(가) 거의 같은 내용이라 한 가지 내용에 점수를 두 번 줄 수 있습니다.`);
        }
      }
    }
  }

  // What the question asks for against what the marking points reward: every point must answer something the question asks.
  const asks = q.asks ?? [];
  if (points.length > 0 && asks.length === 0) {
    if (requireAsks && q.marks >= 2) add('NO_ASKS', '각 채점 기준이 문제의 어느 부분에 답하는지 밝히지 않아, 문제에서 요구하지 않은 기준을 찾을 수 없습니다.');
  } else if (asks.length > 0) {
    const promptWords = new Set(keyWords(q.prompt));
    asks.forEach((a, i) => {
      const quote = `"${a.quote.slice(0, 60)}${a.quote.length > 60 ? '…' : ''}"`;
      const kw = keyWords(a.quote);
      if (kw.length >= 2 && coverage(kw, promptWords) < 0.75) add('ASK_NOT_IN_QUESTION', `요구 사항 ${i + 1}(${quote})이(가) 문제 문장에 없습니다. 문제가 실제로는 이것을 묻지 않을 수 있습니다.`);
      const said = numberIn(a.quote);
      if (said !== undefined && said !== a.count) add('ASK_COUNT', `문제는 ${quote}에서 ${said}개를 말하지만, 이 요구 사항은 ${a.count}개를 원한다고 표시되어 있습니다.`);
      const answering = points.filter((p) => p.ask === i + 1).length;
      if (answering === 0) add('ASK_COUNT', `문제는 ${quote}을(를) 요구하지만 이에 점수를 주는 채점 기준이 없습니다.`);
      else if (answering !== a.count) add('ASK_COUNT', `문제는 ${quote}에서 ${a.count}개를 요구하지만 이에 답하는 채점 기준은 ${answering}개입니다. ${answering > a.count ? '남는 점수는 문제에서 요구하지 않은 것입니다' : '요구한 내용 중 일부는 점수를 받지 못합니다'}.`);
    });
    points.forEach((p, i) => {
      if (p.ask === undefined || !Number.isInteger(p.ask) || p.ask < 1 || p.ask > asks.length) add('POINT_NOT_ASKED', `채점 기준 ${i + 1}("${p.text.slice(0, 50)}…")은(는) 문제가 요구하는 어떤 것에도 답하지 않습니다. 문제에서 이것을 요구하거나 이 기준을 빼세요.`, i + 1);
    });
  }
  if ((q.type === 'scenario' || q.type === 'case') && slideOnly && scenarioAddsNothing(q.prompt, slideOnly)) {
    add('SCENARIO_ADDS_NOTHING', '상황이 슬라이드 내용을 되풀이할 뿐이고 문제는 그것을 쓰거나 설명하라고만 합니다. 앞에 문장 하나를 붙인 암기 문제입니다. 슬라이드에 없는 사례(특정 문자열, 언어, 주장, 인물)를 주고 판단하거나 예측하게 하세요.');
  }
  // one marking point per step: two points resting on the same single step of the slides pay it twice
  if ((q.type === 'algorithm' || q.type === 'programming') && steps.length > 0 && points.length > 1) {
    const stepWords = steps.map((s) => new Set(stepKeys(s)));
    const owner = new Map<number, number>();
    points.forEach((p, i) => {
      const key = stepKeys(p.text);
      if (key.length < 2) return;
      let best = -1;
      let bestScore = 0;
      stepWords.forEach((words, k) => {
        const c = coverage(key, words);
        // the step whose words the point covers, and among equals the more specific step (fewer other words): "If M1 accepts then accept" over a long line that merely contains "M1" and "accepts"
        const score = c * 0.7 + 0.3 * ((c * key.length) / Math.max(1, words.size));
        if (c >= 0.6 && score > bestScore) {
          best = k;
          bestScore = score;
        }
      });
      if (best < 0) return;
      const first = owner.get(best);
      if (first === undefined) owner.set(best, i);
      else add('POINTS_SAME_STEP', `채점 기준 ${first + 1}과(와) ${i + 1}이(가) 슬라이드의 같은 한 단계("${steps[best]!.slice(0, 60)}")에 기대고 있어 한 단계에 점수를 두 번 줍니다. 단계마다 한 번씩만 묻거나 요구하는 것을 줄이세요.`, i + 1);
    });
  }
  if ((q.type === 'scenario' || q.type === 'case' || q.type === 'attack') && scenarioNotNeeded(q.prompt)) {
    add('SCENARIO_NOT_NEEDED', '답하는 데 상황이 필요 없습니다. 문제가 슬라이드의 사실을 쓰라고만 하므로 이야기를 앞에 붙인 암기 문제입니다. 이 상황에서 판단하거나 조언하거나 예측하게 하세요.');
  }

  const answer = q.modelAnswer?.trim() ?? '';
  if (!answer) add('NO_MODEL_ANSWER', '비교할 모범 답안이 없습니다.');
  else {
    const len = wordCount(answer);
    const perMark = isKoreanText(answer) ? 4 : 6;
    const answerWords = new Set(keyWords(answer));
    const missed = points.map((p) => {
      const key = keyWords(p.text);
      const viaKeywords = (p.keywords ?? []).some((k) => keyWords(k).every((w) => has(w, answerWords)) && keyWords(k).length > 0);
      return key.length >= 2 && !viaKeywords && coverage(key, answerWords) < 0.5;
    });
    // A short answer that holds every marking point is a complete answer (a list of three short items); only a short answer that leaves something out is "thin".
    if (len < perMark * q.marks && q.marks >= 2 && (missed.some(Boolean) || len < 2 * q.marks)) add('ANSWER_THIN', `모범 답안이 ${q.marks}점에 ${len}단어뿐입니다. 만점을 받기에는 너무 짧습니다.`);
    if (len > 45 * q.marks + 40) add('ANSWER_LONG', `모범 답안이 ${q.marks}점에 ${len}단어입니다. 배점에 비해 지나치게 깁니다.`);
    points.forEach((p, i) => {
      if (missed[i]) add('ANSWER_MISSES_POINT', `모범 답안에 채점 기준 ${i + 1}("${p.text.slice(0, 50)}…")이(가) 분명히 들어 있지 않아, 완벽한 답안도 만점을 받지 못합니다.`);
    });
  }

  if (slideWords && points.length > 0) {
    // Korean marking points written from English slides (or the reverse) share no words; that says nothing about where they came from.
    // judged on the slides alone: a Korean prompt must not make English slides look Korean
    const slideHasHangul = [...(slideOnly ?? slideWords)].some(isHangulWord);
    points.forEach((p, i) => {
      const key = keyWords(p.text);
      if (key.some(isHangulWord) && !slideHasHangul) return;
      if (key.length >= 3 && coverage(key, slideWords) < 0.34) add('POINT_NOT_ON_SLIDES', `채점 기준 ${i + 1}("${p.text.slice(0, 50)}…")에 인용한 슬라이드에 없는 단어가 쓰였습니다. 슬라이드가 정말 그렇게 말하는지 확인하세요.`);
    });
  }
  return issues;
}

/** Faults of the whole set and between questions. */
function checkSet(qs: readonly QualityQuestion[], existing: readonly string[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const prompts = qs.map((q) => keyWords(q.prompt));
  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) {
      if (prompts[i]!.length >= 3 && jaccard(prompts[i]!, prompts[j]!) >= 0.7) issues.push({ code: 'DUPLICATE', question: j + 1, message: `문제 ${j + 1}이(가) 문제 ${i + 1}과(와) 거의 같습니다.` });
    }
    existing.forEach((e) => {
      const w = keyWords(e);
      if (w.length >= 3 && prompts[i]!.length >= 3 && jaccard(prompts[i]!, w) >= 0.7) issues.push({ code: 'DUPLICATE', question: i + 1, message: `문제 ${i + 1}이(가) 이미 있는 문제와 겹칩니다: “${e.slice(0, 60)}”.` });
    });
  }
  if (qs.length >= 4) {
    const recall = qs.filter((q) => RECALL_TYPES.has(q.type)).length;
    if (recall / qs.length >= 0.7) issues.push({ code: 'ONLY_RECALL', message: `문제 ${qs.length}개 중 ${recall}개가 기억하거나 쓰라고만 합니다(상황, 비교, 문제 해결, 분석 없음). 실제 시험은 보통 그 이상을 묻습니다.` });
    if (new Set(qs.map((q) => q.type)).size === 1) issues.push({ code: 'ONE_TYPE', message: `모든 문제가 같은 유형(${QUESTION_TYPE_LABEL[qs[0]!.type]})입니다.` });
    if (new Set(qs.map((q) => q.difficulty)).size === 1) issues.push({ code: 'ONE_DIFFICULTY', message: `모든 문제의 난이도가 같아(${qs[0]!.difficulty}) 난이도가 아무것도 알려 주지 않습니다.` });
    else if (qs.length >= 5 && !qs.some((q) => q.difficulty >= 3)) issues.push({ code: 'NO_HARD', message: '어려운 문제(난이도 3)가 없습니다. 여러 슬라이드나 단계를 엮는 문제가 없습니다.' });
  }
  return issues;
}

/** The plan against what came back: the model was asked for specific questions. */
function checkPlan(qs: readonly QualityQuestion[], expected: readonly PlannedSlot[], positions: readonly number[] | undefined): { issues: QualityIssue[]; met: number } {
  const issues: QualityIssue[] = [];
  let met = 0;
  const at = (i: number) => positions?.[i] ?? i;
  if (qs.length !== expected.length) {
    const back = new Set(qs.map((_, i) => at(i)));
    const missing = expected.map((_, k) => k + 1).filter((n) => !back.has(n - 1));
    const which = missing.length > 0 && missing.length < expected.length ? ` 계획한 문제 ${missing.join(', ')}번은 쓸 수 있는 형태로 돌아오지 않았습니다.` : '';
    issues.push({ code: 'PLAN_COUNT', message: `문제 ${expected.length}개를 계획했지만 ${qs.length}개가 돌아왔습니다.${which}` });
  }
  const topicKey = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]!;
    const e = expected[at(i)];
    if (!e) continue; // written beyond the plan
    let ok = true;
    if (q.type !== e.type) {
      ok = false;
      issues.push({ code: 'PLAN_TYPE', question: i + 1, message: `${QUESTION_TYPE_LABEL[e.type]}(으)로 계획했지만 ${QUESTION_TYPE_LABEL[q.type]}입니다.` });
    }
    if (Math.abs(q.marks - e.marks) > 1) {
      ok = false;
      issues.push({ code: 'PLAN_MARKS', question: i + 1, message: `${e.marks}점으로 계획했지만 배점이 ${q.marks}점입니다.` });
    }
    if (topicKey(q.topic) !== topicKey(e.topic)) {
      ok = false;
      issues.push({ code: 'PLAN_TOPIC', question: i + 1, message: `주제 “${e.topic}”(으)로 계획했지만 주제가 “${q.topic ?? '없음'}”이라 시험 만들기의 주제 필터에 나타나지 않습니다.` });
    }
    if (ok) met += 1;
  }
  return { issues, met };
}

export function assessQuestions(questions: readonly QualityQuestion[], ctx: QualityContext, options: QualityOptions = {}): QualityReport {
  const issues: QualityIssue[] = [];
  const cited = new Set<string>();
  questions.forEach((q, i) => {
    const texts: string[] = [q.prompt];
    for (const s of q.sources) {
      cited.add(`${s.lectureId}:${s.slide}`);
      const t = ctx.slideText(s.lectureId, s.slide);
      if (t) texts.push(t);
    }
    // the words of a scenario's own situation count as "on the page": a marking point may refer to them
    const slideWords = texts.length > 1 ? new Set(keyWords(texts.join('\n'))) : undefined;
    const slideTexts = q.sources.map((s) => ctx.slideText(s.lectureId, s.slide)).filter((t): t is string => t !== undefined);
    const slideOnly = slideTexts.length > 0 ? new Set(keyWords(joinScripts(slideTexts.join('\n')))) : undefined;
    issues.push(...checkQuestion(q, i + 1, slideWords, options.requireAsks === true, slideOnly, slideTexts.flatMap(stepsOf)));
    // every slide it cites only asks a question (a check-in): the marking points cannot have come from the slides
    if (slideTexts.length > 0 && slideTexts.every(isQuestionText)) {
      issues.push({ code: 'SOURCE_IS_QUESTION', question: i + 1, message: '이 문제가 인용한 슬라이드는 모두 확인 질문입니다. 질문만 하고 답을 주지 않으므로 채점 기준이 슬라이드에서 나올 수 없습니다. 주제를 설명하는 슬라이드를 바탕으로 문제를 만드세요.' });
    }
  });
  issues.push(...checkSet(questions, options.existingPrompts ?? []));
  const stats: QualityStats = {
    questions: questions.length,
    byType: {},
    byDifficulty: { 1: 0, 2: 0, 3: 0 },
    totalMarks: questions.reduce((n, q) => n + q.marks, 0),
    recallShare: questions.length === 0 ? 0 : questions.filter((q) => RECALL_TYPES.has(q.type)).length / questions.length,
    slidesCited: [...cited].sort(),
  };
  for (const q of questions) {
    stats.byType[q.type] = (stats.byType[q.type] ?? 0) + 1;
    const d = Math.min(3, Math.max(1, Math.round(q.difficulty))) as 1 | 2 | 3;
    stats.byDifficulty[d] += 1;
  }
  if (options.expected && options.expected.length > 0) {
    const plan = checkPlan(questions, options.expected, options.positions);
    issues.push(...plan.issues);
    stats.asPlanned = { met: plan.met, of: options.expected.length };
  }
  return { issues, stats };
}
