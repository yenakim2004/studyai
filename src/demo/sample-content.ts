import { PNG_1X1, bodySp, buildPptx, equationShape, mr, para, run, simpleSlide, tableFrame, textBox, titleSp, type DeckSpec } from '../../tests/fixtures/pptx-builder';

/**
 * The sample course of the public demo (docs/DEMO.md): two short lectures and the study material for them, written for this
 * demo. The subject, the units, the tower and mast names and every rule are INVENTED; nothing here comes from a real course, a
 * real person or a real institution. The lecture files are made with the same synthetic deck builder the tests use (this is the
 * one place where application code reaches into tests/, and only the demo build includes it).
 *
 * tests/demo.sample-course.test.ts imports the material through the app's own code and fails if a cited quote is not on its
 * slide, if a question breaks the exam-question rules, or if anything real-looking slips in.
 */

export const SAMPLE_COURSE = { name: '비행선 항법(가상의 데모 과목)', code: 'DEMO 101' } as const;

const sub = (base: string, s: string) => `<m:sSub><m:e>${base}</m:e><m:sub>${s}</m:sub></m:sSub>`;
const mono = (t: string) => para([run(t, { font: 'Consolas' })], { bullet: 'none' });
/** A body line small enough that the formula below it never overlaps the text. */
const line = (t: string, bullet?: 'none') => para([run(t, { sz: 2400 })], bullet ? { bullet } : {});
/** A symbol with a subscript, drawn the way PowerPoint stores it. */
const symbol = (name: string, subscript: string) => [run(name, { sz: 2400 }), run(subscript, { sz: 2400, baseline: -25000 })];
/** Where a formula sits on the slide: below the body text. */
const BELOW_TEXT: [number, number, number, number] = [1000000, 5300000, 4500000, 800000];

/** An equation shape needs the picture it falls back to; the builder wants it declared on every slide that has one. */
const picture = { rels: { rIdImg1: ['image', '../media/image1.png'] } as Record<string, [string, string]>, parts: { 'ppt/media/image1.png': PNG_1X1 } };

/** d_air = d_chart × S */
const SCALE_OMML = sub(mr('d'), mr('air')) + mr('=') + sub(mr('d'), mr('chart')) + mr('×S');
/** d = v × t */
const DISTANCE_OMML = mr('d=v×t');
/** v_g = v_a ± v_w */
const WIND_OMML = sub(mr('v'), mr('g')) + mr('=') + sub(mr('v'), mr('a')) + mr('±') + sub(mr('v'), mr('w'));

export const PLOT_LEG = ['PLOT-LEG(start, heading, ground_speed, hours)', '  distance = ground_speed * hours', '  end = start에서 heading 방향으로 distance만큼 간 지점', '  지도에 end를 표시', '  return end'];

export function lectureOneSpec(): DeckSpec {
  return {
    title: '하늘 지도 읽기',
    author: '가상의 저자',
    slides: [
      { layout: 1, shapes: titleSp(2, '비행선 항법: 하늘 지도 읽기', 'ctrTitle') + bodySp(3, [para('가상의 데모 과목 1강')]) },
      simpleSlide('배울 내용', [
        '하늘 지도의 네 부분을 말할 수 있습니다',
        '신호탑, 계류탑, 폭풍 구역 기호를 읽을 수 있습니다',
        '지도 위의 거리를 공중 거리로 바꿀 수 있습니다',
        '한 구간에 알맞은 안전한 바람층을 고를 수 있습니다',
      ]),
      simpleSlide(
        '하늘 지도의 네 부분',
        ['범례는 지도에 있는 모든 기호를 설명합니다', '나침도는 북쪽을 보여 주며 옆에 나침반 편차가 적혀 있습니다', '바람층은 높이마다 바람이 얼마나 센지 보여 주는 음영 띠입니다', '지형지물은 방향을 잡을 때 기준으로 삼는 고정된 지점입니다'],
        '인쇄한 지도를 들어 보이고, 이름을 말하기 전에 학생들이 각 부분을 찾게 하세요. 데모 지도의 모든 장소는 지어낸 것입니다.',
      ),
      {
        shapes:
          titleSp(2, '지도 기호') +
          tableFrame(4, [
            ['기호', '이름', '알려 주는 것'],
            ['삼각형', '신호탑', '40 km 밖에서도 보이는 고정된 불빛'],
            ['원', '계류탑', '비행선을 매어 둘 수 있는 안전한 곳'],
            ['물결선', '바람층 경계', '두 바람층 사이의 경계'],
            ['가위표', '폭풍 구역', '적어도 15 km 떨어져 있으세요'],
          ]),
      },
      {
        shapes:
          titleSp(2, '축척과 거리') +
          bodySp(3, [
            line('축척은 지도 위 1 cm가 공중에서 얼마나 먼 거리인지 알려 줍니다.'),
            line('축척 1 : 500 000은 지도 위 1 cm가 공중에서 5 km라는 뜻입니다.'),
            line('예: 축척 1 : 500 000인 지도에서 6 cm는 공중에서 30 km입니다.'),
            para([...symbol('d', 'air'), run('는 공중 거리, ', { sz: 2400 }), ...symbol('d', 'chart'), run('는 지도 위 거리, S는 축척입니다.', { sz: 2400 })], { bullet: 'none' }),
          ]) +
          equationShape(5, SCALE_OMML, BELOW_TEXT),
        ...picture,
      },
      simpleSlide(
        '바람층',
        ['1층: 지면부터 500 m까지. 약하고 돌풍이 부는 바람.', '2층: 500 m부터 1 500 m까지. 일정한 바람이라 긴 구간에 가장 좋습니다.', '3층: 1 500 m 위. 센 바람이라 뒷바람일 때만 씁니다.'],
        '바람층 경계는 지어낸 데모 세계의 것이며 실제 비행 규칙이 아닙니다.',
      ),
      simpleSlide('요약', [
        '하늘 지도에는 범례, 나침도, 바람층, 지형지물이 있습니다',
        '기호는 어디로 가고 무엇을 피할지 알려 줍니다',
        '공중 거리는 지도 위 거리에 축척을 곱한 값입니다',
        '긴 구간에는 2층이 가장 좋습니다',
      ]),
    ],
  };
}

export function lectureTwoSpec(): DeckSpec {
  return {
    title: '공중 추측 항법',
    author: '가상의 저자',
    slides: [
      { layout: 1, shapes: titleSp(2, '비행선 항법: 공중 추측 항법', 'ctrTitle') + bodySp(3, [para('가상의 데모 과목 2강')]) },
      simpleSlide('추측 항법이란', [
        '추측 항법은 출발한 곳, 진행 방향, 속도, 지난 시간으로 지금 위치를 알아내는 방법입니다',
        '지형지물이 필요 없어서 구름 속에서도 쓸 수 있습니다',
        '오차는 한 시간마다 커지므로 지형지물이 보일 때마다 위치를 바로잡습니다',
      ]),
      {
        shapes:
          titleSp(2, '거리, 속도, 시간') +
          bodySp(3, [
            line('이동 거리는 대지 속도에 시간을 곱한 값입니다.'),
            line('d는 거리, v는 대지 속도, t는 시간입니다.', 'none'),
            line('예: 24 km/h를 2.5시간 동안 유지한 비행선은 60 km를 갑니다.'),
          ]) +
          equationShape(5, DISTANCE_OMML, BELOW_TEXT),
        ...picture,
        notes: '공식을 보여 주기 전에 칠판에서 학생들과 예제를 함께 풀어 보세요.',
      },
      {
        shapes:
          titleSp(2, '바람은 대지 속도를 바꿉니다') +
          bodySp(3, [
            line('대지 속도는 아래 땅을 기준으로 한 속도입니다'),
            line('뒷바람은 그 속도만큼 대기 속도에 더해집니다'),
            line('맞바람은 그 속도만큼 대기 속도에서 빠집니다'),
            line('예: 대기 속도 20 km/h에 맞바람 4 km/h가 불면 대지 속도는 16 km/h입니다'),
            para([...symbol('v', 'g'), run('는 대지 속도, ', { sz: 2400 }), ...symbol('v', 'a'), run('는 대기 속도, ', { sz: 2400 }), ...symbol('v', 'w'), run('는 바람 속도입니다.', { sz: 2400 })], { bullet: 'none' }),
          ]) +
          equationShape(5, WIND_OMML, BELOW_TEXT),
        ...picture,
      },
      {
        shapes: titleSp(2, '한 구간 그리기') + textBox(4, 700000, 1700000, 7200000, 2000000, PLOT_LEG.map(mono)) + bodySp(3, [para('구간마다 반복합니다. 한 구간의 끝이 다음 구간의 시작입니다.')]),
      },
      {
        shapes:
          titleSp(2, '위치 확인하기') +
          tableFrame(4, [
            ['확인 방법', '언제', '허용 오차'],
            ['신호탑으로 위치 확인', '한 시간마다', '2 km'],
            ['계류탑 관측', '계류할 때마다', '없음, 계류탑은 이미 아는 지점입니다'],
            ['별 관측', '야간 구간에만', '5 km'],
          ]),
      },
      simpleSlide('요약', [
        '추측 항법은 출발점, 진행 방향, 속도, 시간으로 위치를 추정합니다',
        '대지 속도는 대기 속도에 뒷바람을 더하거나 맞바람을 뺀 값입니다',
        '한 번에 한 구간씩 그리고 지형지물로 확인합니다',
      ]),
    ],
  };
}

export interface SampleLecture {
  fileName: string;
  bytes: Uint8Array;
}

/** The two lecture files, built when needed (a few milliseconds). */
export function sampleLectures(): SampleLecture[] {
  return [
    { fileName: '1강 - 하늘 지도 읽기.pptx', bytes: buildPptx(lectureOneSpec()) },
    { fileName: '2강 - 공중 추측 항법.pptx', bytes: buildPptx(lectureTwoSpec()) },
  ];
}

const L1 = '1강 - 하늘 지도 읽기';
const L2 = '2강 - 공중 추측 항법';

/** Flashcards, exam questions and notes as a study pack (the app's own import format), so they pass the same checks as any pack. */
export const SAMPLE_PACK = {
  format: 'studyai-pack',
  version: 1,
  generator: 'StudyAI 데모용으로 직접 작성(지어낸 내용)',
  name: '예시 학습 자료',
  lectures: [
    { ref: 'L1', title: L1, slideCount: 7 },
    { ref: 'L2', title: L2, slideCount: 7 },
  ],
  questions: [
    {
      type: 'mcq',
      prompt: '하늘 지도에서 원 기호는 무엇을 나타내나요?',
      marks: 1,
      difficulty: 1,
      topic: '지도 기호',
      lectures: ['L1'],
      options: [
        { text: '계류탑', correct: true },
        { text: '신호탑', correct: false },
        { text: '폭풍 구역', correct: false },
        { text: '바람층 경계', correct: false },
      ],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 4, quote: '비행선을 매어 둘 수 있는 안전한 곳' }],
    },
    {
      type: 'truefalse',
      prompt: '뒷바람은 대지 속도를 줄인다.',
      marks: 1,
      difficulty: 1,
      topic: '바람과 대지 속도',
      lectures: ['L2'],
      answer: false,
      basis: 'lecture',
      sources: [{ lecture: 'L2', slide: 4, quote: '뒷바람은 그 속도만큼 대기 속도에 더해집니다' }],
    },
    {
      type: 'mcq',
      prompt: '긴 구간에 가장 좋은 바람층은 어느 것인가요?',
      marks: 1,
      difficulty: 1,
      topic: '바람층',
      lectures: ['L1'],
      options: [
        { text: '1층, 지면부터 500 m까지', correct: false },
        { text: '2층, 500 m부터 1 500 m까지', correct: true },
        { text: '3층, 1 500 m 위', correct: false },
      ],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 6, quote: '일정한 바람이라 긴 구간에 가장 좋습니다' }],
    },
    {
      type: 'short',
      prompt: '추측 항법이란 무엇이며, 왜 구름 속에서도 쓸 수 있나요?',
      marks: 2,
      difficulty: 2,
      topic: '추측 항법',
      lectures: ['L2'],
      modelAnswer: '추측 항법은 출발한 곳, 진행 방향, 속도, 지난 시간으로 지금 위치를 알아내는 방법입니다. 지형지물이 필요 없어서 구름 속에서도 쓸 수 있습니다.',
      rubric: [
        { text: '출발한 곳, 진행 방향, 속도, 시간으로 위치를 알아낸다', marks: 1, keywords: ['출발', '방향', '속도', '시간'] },
        { text: '지형지물이 필요 없어서 구름 속에서도 쓸 수 있다', marks: 1, keywords: ['지형지물'] },
      ],
      expectedWords: [16, 28],
      hint: '2강의 2번 슬라이드를 보세요.',
      basis: 'lecture',
      sources: [{ lecture: 'L2', slide: 2, quote: '지형지물이 필요 없어서 구름 속에서도 쓸 수 있습니다' }],
    },
    {
      type: 'short',
      prompt: '하늘 지도의 네 부분을 쓰시오.',
      marks: 4,
      difficulty: 2,
      topic: '지도의 구성',
      lectures: ['L1'],
      modelAnswer: '하늘 지도에는 기호를 설명하는 범례, 북쪽을 보여 주는 나침도, 높이마다 바람 세기를 보여 주는 바람층, 방향을 잡는 기준이 되는 지형지물이 있습니다.',
      rubric: [
        { text: '범례', marks: 1, keywords: ['범례'] },
        { text: '나침도', marks: 1, keywords: ['나침도'] },
        { text: '바람층', marks: 1, keywords: ['바람층'] },
        { text: '지형지물', marks: 1, keywords: ['지형지물'] },
      ],
      expectedWords: [16, 56],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 3, quote: '바람층은 높이마다 바람이 얼마나 센지 보여 주는 음영 띠입니다' }],
    },
    {
      type: 'calculation',
      prompt: '대기 속도가 20 km/h인 비행선이 4 km/h의 맞바람을 받으며 2.5시간 동안 날아갑니다. 땅 위로 얼마나 가나요? 단계마다 풀이를 쓰시오.',
      marks: 3,
      difficulty: 2,
      topic: '바람과 대지 속도',
      lectures: ['L2'],
      modelAnswer: '맞바람은 그 속도만큼 빠지므로 대지 속도는 20 - 4 = 16 km/h입니다. 이동 거리는 대지 속도에 시간을 곱한 값이므로 16 x 2.5 = 40 km입니다.',
      rubric: [
        { text: '대기 속도에서 맞바람을 빼서 대지 속도 16 km/h를 구한다', marks: 1, keywords: ['16'] },
        { text: '대지 속도에 시간 2.5를 곱한다', marks: 1, keywords: ['2.5'] },
        { text: '이동 거리 40 km를 구한다', marks: 1, keywords: ['40'] },
      ],
      expectedWords: [14, 42],
      basis: 'lecture',
      sources: [
        { lecture: 'L2', slide: 4, quote: '대기 속도 20 km/h에 맞바람 4 km/h가 불면 대지 속도는 16 km/h입니다' },
        { lecture: 'L2', slide: 3, quote: '이동 거리는 대지 속도에 시간을 곱한 값입니다' },
      ],
    },
    {
      type: 'scenario',
      prompt:
        '비행선이 2번 계류탑에서 5번 계류탑까지 날아가야 합니다. 지도에서 두 계류탑은 8 cm 떨어져 있고 축척은 1 : 500 000입니다. 대지 속도는 20 km/h이고, 구간의 마지막 부분은 지형지물이 하나도 보이지 않는 짙은 구름 속입니다. 이 구간은 얼마나 걸리며, 구름 속에서 위치를 어떻게 계속 파악하겠습니까?',
      asks: [
        { quote: '이 구간은 얼마나 걸리며', count: 2 },
        { quote: '구름 속에서 위치를 어떻게 계속 파악하겠습니까', count: 2 },
      ],
      marks: 4,
      difficulty: 3,
      topic: '추측 항법',
      lectures: ['L1', 'L2'],
      modelAnswer:
        '두 계류탑은 8 cm 떨어져 있고 지도 위 1 cm는 공중에서 5 km이므로 구간은 8 x 5 = 40 km입니다. 대지 속도 20 km/h로 이 구간은 40 / 20 = 2시간 걸립니다. 구름 속에는 지형지물이 없으므로 마지막으로 안 위치와 진행 방향, 속도, 시간으로 추측 항법을 쓰고, 지형지물이 보이면 바로 위치를 바로잡습니다.',
      rubric: [
        { text: '지도 위 8 cm를 공중 거리 40 km로 바꾼다', marks: 1, ask: 1, keywords: ['40'] },
        { text: '거리를 대지 속도로 나누어 2시간을 구한다', marks: 1, ask: 1, keywords: ['2시간'] },
        { text: '지형지물이 필요 없으므로 구름 속에서 추측 항법을 쓴다', marks: 1, ask: 2, keywords: ['추측 항법'] },
        { text: '지형지물이 보일 때마다 위치를 바로잡는다', marks: 1, ask: 2, keywords: ['바로잡'] },
      ],
      expectedWords: [32, 56],
      basis: 'derived',
      sources: [
        { lecture: 'L1', slide: 5, quote: '축척 1 : 500 000은 지도 위 1 cm가 공중에서 5 km라는 뜻입니다' },
        { lecture: 'L2', slide: 3, quote: '이동 거리는 대지 속도에 시간을 곱한 값입니다' },
        { lecture: 'L2', slide: 2, quote: '지형지물이 필요 없어서 구름 속에서도 쓸 수 있습니다' },
        { lecture: 'L2', slide: 2, quote: '지형지물이 보일 때마다 위치를 바로잡습니다' },
      ],
    },
    {
      type: 'compare',
      prompt: '바람층 1층과 2층을 비교하고, 긴 구간에는 어느 층을 고를지 쓰시오.',
      marks: 3,
      difficulty: 2,
      topic: '바람층',
      lectures: ['L1'],
      modelAnswer: '1층은 지면부터 500 m까지이고 약하고 돌풍이 부는 바람이 붑니다. 2층은 500 m부터 1 500 m까지이고 일정한 바람이 붑니다. 긴 구간에는 2층이 더 좋습니다.',
      rubric: [
        { text: '1층은 낮고 약하고 돌풍이 부는 바람이다', marks: 1, keywords: ['돌풍'] },
        { text: '2층은 더 높고 일정한 바람이다', marks: 1, keywords: ['일정'] },
        { text: '긴 구간에는 2층을 고른다', marks: 1, keywords: ['2층'] },
      ],
      expectedWords: [20, 42],
      basis: 'lecture',
      sources: [
        { lecture: 'L1', slide: 6, quote: '약하고 돌풍이 부는 바람' },
        { lecture: 'L1', slide: 6, quote: '일정한 바람이라 긴 구간에 가장 좋습니다' },
      ],
    },
  ],
  cards: [
    { type: 'definition', front: '추측 항법이란 무엇인가요?', back: '출발한 곳, 진행 방향, 속도, 지난 시간으로 지금 위치를 알아내는 방법입니다.', lecture: 'L2', basis: 'lecture', tags: ['추측 항법'], sources: [{ lecture: 'L2', slide: 2, quote: '출발한 곳, 진행 방향, 속도, 지난 시간으로 지금 위치를 알아내는 방법입니다' }] },
    { type: 'qa', front: '추측 항법은 왜 구름 속에서도 쓸 수 있나요?', back: '지형지물이 필요 없기 때문입니다.', lecture: 'L2', basis: 'lecture', tags: ['추측 항법'], sources: [{ lecture: 'L2', slide: 2, quote: '지형지물이 필요 없어서 구름 속에서도 쓸 수 있습니다' }] },
    { type: 'concept', front: '추측 항법의 오차는 어떻게 되며, 어떻게 대처하나요?', back: '한 시간마다 커지므로 지형지물이 보일 때마다 위치를 바로잡습니다.', lecture: 'L2', basis: 'lecture', tags: ['추측 항법'], sources: [{ lecture: 'L2', slide: 2, quote: '오차는 한 시간마다 커지므로' }] },
    { type: 'formula', front: '이동 거리는 어떻게 구하나요?', back: '거리 = 대지 속도 × 시간.', lecture: 'L2', basis: 'lecture', tags: ['공식'], sources: [{ lecture: 'L2', slide: 3, quote: '이동 거리는 대지 속도에 시간을 곱한 값입니다' }] },
    { type: 'formula', front: '바람은 대지 속도를 어떻게 바꾸나요?', back: '대지 속도 = 대기 속도 + 뒷바람, 또는 대기 속도 − 맞바람.', lecture: 'L2', basis: 'lecture', tags: ['공식'], sources: [{ lecture: 'L2', slide: 4, quote: '뒷바람은 그 속도만큼 대기 속도에 더해집니다' }] },
    { type: 'qa', front: '대기 속도 20 km/h에 맞바람 4 km/h일 때 대지 속도는 얼마인가요?', back: '16 km/h입니다.', lecture: 'L2', basis: 'lecture', tags: ['공식'], sources: [{ lecture: 'L2', slide: 4, quote: '대기 속도 20 km/h에 맞바람 4 km/h가 불면 대지 속도는 16 km/h입니다' }] },
    { type: 'code', front: 'PLOT-LEG의 첫 단계는 무엇인가요?', back: '거리를 구합니다: ground_speed * hours.', lecture: 'L2', basis: 'lecture', tags: ['구간 그리기'], sources: [{ lecture: 'L2', slide: 5, quote: 'distance = ground_speed * hours' }] },
    { type: 'definition', front: '하늘 지도에서 삼각형 기호는 무엇을 나타내나요?', back: '신호탑: 40 km 밖에서도 보이는 고정된 불빛입니다.', lecture: 'L1', basis: 'lecture', tags: ['기호'], sources: [{ lecture: 'L1', slide: 4, quote: '40 km 밖에서도 보이는 고정된 불빛' }] },
    { type: 'definition', front: '하늘 지도에서 원 기호는 무엇을 나타내나요?', back: '계류탑: 비행선을 매어 둘 수 있는 안전한 곳입니다.', lecture: 'L1', basis: 'lecture', tags: ['기호'], sources: [{ lecture: 'L1', slide: 4, quote: '비행선을 매어 둘 수 있는 안전한 곳' }] },
    { type: 'qa', front: '폭풍 구역에서는 얼마나 떨어져 있어야 하나요?', back: '적어도 15 km입니다.', lecture: 'L1', basis: 'lecture', tags: ['기호'], sources: [{ lecture: 'L1', slide: 4, quote: '적어도 15 km 떨어져 있으세요' }] },
    { type: 'formula', front: '지도 위 거리를 공중 거리로 어떻게 바꾸나요?', back: '공중 거리 = 지도 위 거리 × 축척. 축척 1 : 500 000에서는 지도 위 1 cm가 공중에서 5 km입니다.', lecture: 'L1', basis: 'lecture', tags: ['공식'], sources: [{ lecture: 'L1', slide: 5, quote: '축척 1 : 500 000은 지도 위 1 cm가 공중에서 5 km라는 뜻입니다' }] },
    { type: 'qa', front: '축척 1 : 500 000인 지도에서 6 cm는 공중에서 얼마인가요?', back: '30 km입니다.', lecture: 'L1', basis: 'lecture', tags: ['공식'], sources: [{ lecture: 'L1', slide: 5, quote: '축척 1 : 500 000인 지도에서 6 cm는 공중에서 30 km입니다' }] },
    { type: 'comparison', front: '바람층 1층과 2층을 비교하세요.', back: '1층(지면부터 500 m까지)은 약하고 돌풍이 부는 바람입니다. 2층(500 m부터 1 500 m까지)은 일정한 바람이라 긴 구간에 가장 좋습니다.', lecture: 'L1', basis: 'lecture', tags: ['바람층'], sources: [{ lecture: 'L1', slide: 6, quote: '일정한 바람이라 긴 구간에 가장 좋습니다' }] },
  ],
  notes: [
    {
      title: '1강 요약: 하늘 지도 읽기',
      kind: 'summary',
      lecture: 'L1',
      blocks: [
        { text: '하늘 지도는 네 부분으로 되어 있습니다: **범례**, **나침도**, **바람층**, **지형지물**.', basis: 'lecture', sources: [{ lecture: 'L1', slide: 3, quote: '범례는 지도에 있는 모든 기호를 설명합니다' }] },
        { text: '공중 거리는 지도 위 거리에 축척을 곱한 값입니다: $d_{air} = d_{chart} \\times S$. 1 : 500 000에서 1센티미터는 5킬로미터입니다.', basis: 'lecture', sources: [{ lecture: 'L1', slide: 5, quote: '축척 1 : 500 000은 지도 위 1 cm가 공중에서 5 km라는 뜻입니다' }] },
      ],
    },
    {
      title: '2강 요약: 추측 항법',
      kind: 'summary',
      lecture: 'L2',
      blocks: [
        { text: '추측 항법에는 출발점, 진행 방향, 속도, 시간이 필요합니다. 구름 속에서도 쓸 수 있지만 오차가 커지므로 지형지물마다 바로잡습니다.', basis: 'lecture', sources: [{ lecture: 'L2', slide: 2, quote: '오차는 한 시간마다 커지므로' }] },
        { text: '대지 속도는 대기 속도에 뒷바람을 더하거나 맞바람을 뺀 값입니다: $v_g = v_a \\pm v_w$. 그다음 $d = v \\times t$.', basis: 'lecture', sources: [{ lecture: 'L2', slide: 4, quote: '맞바람은 그 속도만큼 대기 속도에서 빠집니다' }] },
      ],
    },
  ],
};
