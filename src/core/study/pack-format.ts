import { slotTokens, type PlannedSlot } from './blueprint';
import { BASES, CARD_TYPES, NOTE_KINDS, QUESTION_TYPES } from './types';

/**
 * The study-pack format identifiers and the instructions given to an AI that writes a pack. Kept apart from the Markdown
 * export (which needs the PowerPoint model) so the Worker can build prompts without bundling the PowerPoint engine.
 */
export const PACK_FORMAT = 'studyai-pack';
export const PACK_VERSION = 1;

/** The pack skeleton shown to the AI: precise, short, and including the provenance rules. Keys and enum values stay as the importer reads them. */
const SCHEMA_EXAMPLE = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  generator: 'AI 이름과 날짜',
  lectures: [{ ref: 'L1', title: '내보내기에 적힌 강의 제목 그대로', fileHash: '내보내기 주석의 해시', slideCount: 40 }],
  // Questions come first, then cards, then notes: if an answer is ever cut off, what is lost is the least valuable part.
  questions: [
    {
      type: 'scenario',
      prompt: '필수. 학생이 읽는 문제 전문: 짧은 상황 설명 뒤에 질문. 예: ... 세 가지를 쓰시오',
      asks: [{ quote: '무언가를 요구하는 prompt 속 문구를 그대로 복사, 예: 세 가지를 쓰시오', count: 3 }],
      marks: 3,
      difficulty: 3,
      topic: '주어진 주제 제목을 그대로',
      lectures: ['L1'],
      modelAnswer: '만점을 받는 학생이 쓰는 답: 세 가지 내용을 한 번씩, 슬라이드 내용만으로',
      rubric: [{ text: '첫째 독립된 내용', marks: 1, ask: 1, keywords: ['선택', '단어'] }, { text: '둘째 독립된 내용', marks: 1, ask: 1 }, { text: '셋째 독립된 내용', marks: 1, ask: 1 }],
      expectedWords: [24, 42],
      hint: '답을 알려 주지 않는 선택적 힌트',
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 12, quote: '12번 슬라이드의 문장을 원문 그대로 복사' }],
    },
  ],
  cards: [{ type: 'definition', front: '질문 면', back: '답 면', lecture: 'L1', basis: 'lecture', tags: ['주제'], sources: [{ lecture: 'L1', slide: 12, quote: '12번 슬라이드의 문장을 원문 그대로 복사' }] }],
  notes: [{ title: '주제 요약: …', kind: 'summary', lecture: 'L1', blocks: [{ text: '$latex$를 쓸 수 있는 마크다운', basis: 'lecture', sources: [{ lecture: 'L1', slide: 12, quote: '12번 슬라이드의 문장을 원문 그대로 복사' }] }] }],
};

export interface PromptOptions {
  /** Professor / exam-format instructions saved for the course. */
  examStyle?: string;
  wants: { notes: boolean; cards: boolean; questions: boolean };
  /** Roughly how many items of each kind to ask for. */
  amount: 'few' | 'normal' | 'many';
  /**
   * The most tokens the AI may write in its answer. When it is set the counts are cut down until the whole pack fits, and
   * the AI is told to keep every field short, because an answer that hits the cap is cut off in the middle of the JSON.
   */
  outputTokens?: number;
  /** The planned questions (see blueprint.ts). When given, they replace the generic "N questions" and fix type, marks and topic. */
  blueprint?: readonly PlannedSlot[];
  /** Applied to text that came from the student's lecture (topic titles) before it is placed in the prompt. */
  escape?: (text: string) => string;
}

export type PackKind = 'notes' | 'cards' | 'questions';

const BASE_COUNTS = { few: [5, 10, 6], normal: [10, 25, 12], many: [20, 50, 25] } as const;
/** Tokens of JSON one item takes with its sources and quotes (measured on real English answers, rounded up; questions are estimated). */
const ITEM_TOKENS: Record<PackKind, number> = { notes: 220, cards: 130, questions: 330 };
const OVERHEAD_TOKENS = 150;
/** Leave a third of the cap unused: answers vary in length and a cut-off answer is worse than a short one. */
const FILL = 0.7;

/** How many items of each kind the request asks for. Zero for a kind that is not wanted. */
export function packCounts(o: Pick<PromptOptions, 'wants' | 'amount' | 'outputTokens' | 'blueprint'>): Record<PackKind, number> {
  if (o.blueprint && o.blueprint.length > 0) {
    // The planned questions are fixed (the plan was already cut to fit one answer); cards and notes only get what room is left.
    const room = o.outputTokens === undefined ? Infinity : Math.floor(o.outputTokens * FILL) - OVERHEAD_TOKENS - o.blueprint.reduce((n, s) => n + slotTokens(s), 0);
    const rest = packCounts({ wants: { ...o.wants, questions: false }, amount: o.amount, ...(room === Infinity ? {} : { outputTokens: Math.max(0, room) + OVERHEAD_TOKENS * 2 }) });
    return { notes: rest.notes, cards: rest.cards, questions: o.blueprint.length };
  }
  const [bn, bc, bq] = BASE_COUNTS[o.amount];
  const base: Record<PackKind, number> = { notes: o.wants.notes ? bn : 0, cards: o.wants.cards ? bc : 0, questions: o.wants.questions ? bq : 0 };
  if (o.outputTokens === undefined) return base;
  const cost = (c: Record<PackKind, number>) => c.notes * ITEM_TOKENS.notes + c.cards * ITEM_TOKENS.cards + c.questions * ITEM_TOKENS.questions;
  const room = Math.max(0, Math.floor(o.outputTokens * FILL) - OVERHEAD_TOKENS);
  const total = cost(base);
  if (total <= room) return base;
  const scale = room / total;
  const kinds: PackKind[] = ['questions', 'cards', 'notes'];
  const fit = { ...base };
  for (const k of kinds) fit[k] = base[k] === 0 ? 0 : Math.max(1, Math.floor(base[k] * scale));
  // Spend what is left, one item at a time, so a small pack does not waste its room.
  for (let added = true; added; ) {
    added = false;
    for (const k of kinds) {
      if (fit[k] > 0 && fit[k] < base[k] && cost(fit) + ITEM_TOKENS[k] <= room) {
        fit[k] += 1;
        added = true;
      }
    }
  }
  return fit;
}

/** What makes an exam question good, kind by kind. The checks in pack-quality.ts hold the answer to the same rules. */
export const QUESTION_RULES = `문제 작성: 이 슬라이드로 좋은 시험 문제를 만드는 방법
A. 유형. 각 문제는 지정된 "type"으로 쓰고, 실제로 그 유형다운 문제여야 합니다.
   - define: 슬라이드에 나온 용어를, 그것이 무엇을 위한 것인지나 어떻게 동작하는지와 함께 묻습니다.
   - short: 몇 문장으로 답하는 하나의 초점 있는 질문(왜, 어떻게, 어떤 경우에 무엇이 일어나는가).
   - compare: 슬라이드에 나온 둘 이상의 대상을, 문제에서 밝힌 측면으로 비교합니다.
   - scenario: 짧은 가상 상황(2~4문장, 구체적이고 학생에게 새로운 상황)에서 슬라이드의 개념을 적용하게 합니다. 이 상황에서 판단, 조언, 예측, 진단, 정당화하게 하여 상황의 세부 내용이 답을 바꾸도록 하세요. 상황은 지어내도 되지만 모든 채점 기준은 슬라이드에 있어야 합니다. 문제가 슬라이드의 사실을 쓰라고만 한다면 이야기는 장식일 뿐이니 short 문제로 쓰세요. 상황에는 슬라이드에 없는 무언가(특정 문자열, 언어, 기계, 수치, 주장, 인물)가 있어야 슬라이드의 개념을 적용할 수 있습니다. "슬라이드의 기계를 만들고 있다. 그것을 설명하시오"는 슬라이드 앞에 문장 하나를 붙인 것에 불과합니다. 형식적이거나 수학적인 내용에서는 판단할 주장이나 짧은 논증(학생이 시도한 한 단계, 제시된 결과, 두 줄로 설명한 기계)이 상황이 될 수 있습니다. 학생은 슬라이드에 나온 결과만으로 그것이 성립하는지와 이유를 답합니다.
   - case: 두세 부분 (a), (b), (c)로 된 더 긴 상황.
   - attack: 위협과 그것을 약화하거나 막는 방법을, 슬라이드가 제시한 대로만.
   - problem, calculation: 슬라이드의 방법으로 풀 수 있는 문제. 필요한 수치는 모두 문제에 주고, 모범 답안은 각 단계를 보여 줍니다.
   - proof: 슬라이드에 나온 방법을 따르는 짧은 논증이나 유도. 단계마다 채점 기준 하나. 슬라이드에 나온 단계만 쓰세요. 슬라이드가 빠뜨린 단계, 보조정리, 이유를 추가하지 말고, 슬라이드가 건너뛴 단계를 채우지 마세요.
   - algorithm, programming: 슬라이드와 같은 방식으로 단계를 추적하거나 작성. 단계마다 채점 기준 하나. 한 단계를 두 기준으로 나누거나, 배점을 채우려고 준비 문장에 기준을 추가하지 마세요. 슬라이드의 단계가 배점보다 적으면 배점을 줄이세요. "단계 또는 결과"가 아니라 "단계"(또는 "전이")를 물으세요. 슬라이드에 나온 기계나 오토마타는 주어진 입력에 대한 실행(또는 정해진 일을 하는 기계)을 묻고, 전이나 결정마다 채점 기준 하나를 둡니다.
   - diagram: 글자가 슬라이드에 있는 그림이 무엇을 보여 주고 왜 중요한지.
   - mcq: 정답 하나와 실제 오개념을 반영한 그럴듯한 오답(항상 "options"를 쓰세요). truefalse: 슬라이드 기준으로 분명히 참이거나 거짓인 진술(항상 "answer": true 또는 false를 쓰세요).
   - long: 여러 개념을 연결하는 구조적인 답.
B. 난이도. 1 = 슬라이드 하나의 개념 하나를 말하거나 알아보기. 2 = 슬라이드 1~3장의 개념을 설명, 비교, 적용하기. 3 = 여러 슬라이드나 여러 단계가 필요해서 정의만 외운 학생은 답할 수 없는 상황이나 문제.
C. 배점. 1점에 독립된 내용 하나 정도: 1점 문제는 사실 하나, 6점 문제는 서로 다른 여섯 가지를 요구합니다. 문제 문장이 요구하는 양을 밝힙니다("두 가지를 쓰시오", "이유 세 가지를 제시하시오").
D. 채점 기준. 각 기준은 학생이 따로 받을 수 있는 내용 하나입니다. 그 내용만 쓴 학생은 그 점수만 받습니다. 기준끼리 겹치거나 포함하면 안 됩니다. "다음 중 두 가지", "모두", "적어도", "A 또는 B"를 기준으로 쓰지 말고, 내용을 따로 나열한 뒤 정해진 개수를 요구하세요. 기준의 합은 문제 배점과 같고, 각 기준에는 출처 인용이 있어야 합니다.
E. 모범 답안. 만점을 받는 학생이 쓰는 답입니다. 모든 채점 기준을 한 번씩, 쉬운 말로, 1점당 약 8~14단어(어절)로, 슬라이드가 말하는 내용만으로 씁니다(scenario는 슬라이드의 개념을 상황에 적용). 슬라이드를 벗어나는 내용은 넣지 마세요. "expectedWords"는 [8 x 배점, 14 x 배점]으로 정하세요. 3점 문제는 [24, 42]입니다.
F. 다양성. 각 문제는 서로 다른 개념이나 다른 슬라이드를 다룹니다. <already_asked>가 있으면 그 목록의 문제를 반복하거나 바꿔 쓰지 마세요. "topic"은 주어진 그대로 복사하세요.
G. 문제 문장. 모든 문제에는 "prompt"가 있어야 합니다. 학생이 읽는 문제 전문이며, 답과 채점 기준보다 먼저 씁니다. "prompt"가 없는 문제는 나머지가 아무리 좋아도 버려집니다. 다른 항목을 모두 짧게 쓰더라도 이것은 지키세요.
H. 요구 사항. prompt 다음에 학생에게 요구하는 것을 하나하나 "asks"에 나열합니다: {"quote": 그것을 요구하는 prompt 속 문구 그대로, "count": 원하는 항목이나 내용의 개수}. 그리고 각 채점 기준에 어느 요구 사항에 답하는지 적습니다: 첫째 요구 사항이면 "ask": 1. count가 3인 요구 사항에는 채점 기준이 정확히 세 개 있고, quote 속 숫자("이유 세 가지")는 count와 같으며, count의 합은 배점과 같습니다. prompt가 요구하지 않은 것에 기준이나 점수를 더하지 마세요. 어떤 내용에 점수를 주려면 먼저 prompt에서 그것을 요구하세요. prompt가 요구하는 모든 것에는 채점 기준이 있어야 합니다.
I. 슬라이드에 적힌 질문. 슬라이드의 질문(확인 문제, 투표, "왜 이것이 ...인가?")은 강의가 청중에게 던진 것이지 답한 것이 아닙니다. 그 질문에 대한 내 답을 슬라이드가 준 것처럼 채점 기준이나 모범 답안에 쓰지 마세요. 채점 기준은 슬라이드가 말하는 내용에 두고, 슬라이드가 답하지 않으면 슬라이드가 답하는 다른 문제를 쓰세요.`;

function blueprintBlock(slots: readonly PlannedSlot[], escape: (s: string) => string): string {
  const lines = slots.map((s, i) => {
    return `${i + 1}. type "${s.type}", 난이도 ${s.difficulty}, ${s.marks}점, 채점 기준 ${s.points}개, 주제 ${JSON.stringify(escape(s.topic))}, 근거 슬라이드 ${s.slides.join(', ')}`;
  });
  return `작성할 문제: 정확히 ${slots.length}개, 이 순서대로 "questions" 목록에
${lines.join('\n')}
각 문제의 유형, 난이도, 배점, 채점 기준 개수는 주어진 대로 지키고, 지정된 슬라이드를 바탕으로 만드세요. 필요하면 다른 슬라이드도 쓸 수 있습니다. 위 줄은 무엇을 쓸지 알려 줄 뿐 문제 자체가 아닙니다. 학생이 읽을 문장은 각 문제의 "prompt"에 쓰세요.`;
}

/** What every generated text must look like: Korean for the student, the slides' own wording for evidence, the format's own names for the app. */
export const KOREAN_OUTPUT_RULE = `언어: 학생이 읽는 모든 글(문제, 답, 카드, 노트, 힌트, 채점 기준, 설명)은 자연스러운 한국어로 쓰세요. 전문 용어는 슬라이드에 나온 표기를 따르고, 필요하면 처음 한 번 괄호 안에 원어를 덧붙이세요. 단, "quote"는 슬라이드 문장을 원래 언어 그대로 한 글자도 바꾸지 말고 복사하며 번역하지 마세요. JSON 키, "type"·"kind"·"basis" 값, 강의 ref(L1), 슬라이드 번호는 형식에 적힌 그대로 둡니다.`;

export function studyPackPrompt(o: PromptOptions): string {
  const n = packCounts(o);
  const escape = o.escape ?? ((s: string) => s);
  const planned = !!o.blueprint && o.blueprint.length > 0;
  const want = [
    n.notes > 0 && `노트 ${n.notes}개(요약, 정의, 비교표, 자주 하는 실수)`,
    n.cards > 0 && `플래시카드 ${n.cards}장`,
    n.questions > 0 && (planned ? `채점 기준이 있는 시험 문제 ${n.questions}개(아래 목록)` : `채점 기준이 있는 시험형 문제 ${n.questions}개`),
  ]
    .filter(Boolean)
    .join(', ');
  // The format example shows all three lists; a model fills in the ones it was not asked for unless told to leave them empty.
  const unwanted = (['notes', 'cards', 'questions'] as const).filter((k) => n[k] === 0);
  const emptyLists = unwanted.length > 0 && unwanted.length < 3 ? ` 요청한 것만 쓰세요. ${unwanted.map((k) => `"${k}"`).join('와 ')}은(는) 빈 목록([])으로 두세요.` : '';
  const compact =
    o.outputTokens === undefined
      ? ''
      : `\n9. 답 전체는 약 ${Math.floor(o.outputTokens * 0.35).toLocaleString('ko-KR')}단어로 제한되며 중간에 잘리면 버려지므로, 반드시 완결된 올바른 JSON이어야 합니다. 모든 항목을 짧게 쓰세요. 인용문은 6~15단어, 노트 블록은 최대 60단어, 항목당 출처는 한두 개입니다. 항목을 다 넣을 수 없으면 항목 수를 줄이고, 항목을 길게 쓰지 마세요.`;
  return `당신은 대학생이 강의 슬라이드로 공부하도록 돕고 있습니다. 강의 텍스트는 이 메시지 뒤에 이어집니다.

과제
아래 강의로 ${want || '학습 자료'}을(를) 만들고, 끝에 보인 "${PACK_FORMAT}" 형식의 JSON 객체 하나로 돌려주세요. JSON만 돌려주세요(코드 블록 하나는 괜찮습니다).${emptyLists}

${KOREAN_OUTPUT_RULE}

규칙 (양보다 중요합니다)
1. 슬라이드가 사실의 기준입니다. 강의 내용, 정의, 증명 단계, 시험 규칙, 교수가 선호하는 것을 지어내지 마세요.
2. 모든 항목에는 "basis"가 필요합니다.
   - "lecture"   = 항목이 슬라이드에 적혀 있음(반드시 quote를 주세요)
   - "derived"   = 슬라이드 내용에서 합리적으로 이끌어 낸 설명
   - "outside"   = 이해를 돕기 위해 더한, 슬라이드에 없는 지식
   - "uncertain" = 확실하지 않거나 슬라이드가 뒷받침하지 않음
3. 모든 항목에는 "sources"가 필요합니다: [{"lecture": "<ref>", "slide": <슬라이드 번호>, "quote": "<그 슬라이드에서 그대로 복사한 문장>"}]. quote는 슬라이드에서 한 글자도 바꾸지 말고 복사하세요(3~25단어, 단어를 건너뛸 때는 "..."). 학생의 앱이 모든 quote를 실제 슬라이드와 대조해 맞지 않는 것을 표시하므로 quote 안에서 바꿔 말하거나 번역하지 마세요. quote는 항목 전체를 뒷받침해야 합니다. 카드, 노트, 답의 어느 부분이라도 인용한 문장이 말하지 않는 일반 지식이면(사실이라도) 그 항목의 basis는 "outside"나 "derived"이고 절대 "lecture"가 아닙니다. 슬라이드의 표현이 교과서의 뜻과 다르면 슬라이드가 말하는 대로 쓰세요.
4. 슬라이드 텍스트가 읽을 수 없음, 이미지로 표시되었거나 "Extraction caveats"가 있으면 그 안의 내용을 단정하지 마세요.
5. 슬라이드에 오류나 모순이 있으면 조용히 고치지 말고 항목 안에서 밝히세요(basis "uncertain").
6. 배점: "rubric" 점수의 합은 문제의 "marks"와 같아야 합니다. 유형, 난이도, 채점 기준, 모범 답안은 아래 문제 작성 지침을 따르세요.
7. 수학은 $...$ 안의 LaTeX로 쓰세요. 렌더링이 필요한 다른 마크업은 쓰지 마세요.
8. 허용 값: 카드 "type": ${CARD_TYPES.join(', ')}. 노트 "kind": ${NOTE_KINDS.join(', ')}. 문제 "type": ${QUESTION_TYPES.join(', ')}. "basis": ${BASES.join(', ')}. "mcq"는 정답이 하나 이상인 "options": [{"text":…, "correct":…}]를, "truefalse"는 "answer": true|false를 주세요.${compact}
${n.questions > 0 ? `\n${QUESTION_RULES}\n` : ''}${planned ? `\n${blueprintBlock(o.blueprint!, escape)}\n` : ''}${o.examStyle?.trim() ? `\n교수의 출제 스타일(문제와 답을 쓸 때 따르세요. 문제 작성 지침과 다르면 교수의 스타일이 우선입니다):\n${o.examStyle.trim()}\n` : ''}
형식
${JSON.stringify(SCHEMA_EXAMPLE, null, 2)}`;
}
/** The questions that already exist, as a block of data for the prompt (the caller escapes each line). */
export function alreadyAskedBlock(lines: readonly string[]): string {
  const cleaned = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return cleaned.length === 0 ? '' : `<already_asked>\n${cleaned.map((l) => `- ${l}`).join('\n')}\n</already_asked>`;
}
