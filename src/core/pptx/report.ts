import type { Confidence, ExtractionReport, Flag, FlagCode, SlideData, Topic } from './model';

export function scoreSlide(slide: SlideData): Confidence {
  if (slide.status === 'failed') return 'low';
  const open = slide.flags.filter((f) => !f.resolved);
  if (open.some((f) => f.severity === 'attention')) return 'low';
  if (open.some((f) => f.severity === 'warning')) return 'medium';
  return 'high';
}

/** Plain-language label per flag code, used in the "potentially missing content" list. */
const MISSING_LABEL: Partial<Record<FlagCode, string>> = {
  SLIDE_PARSE_FAILED: '전혀 읽지 못한 슬라이드',
  NO_EXTRACTABLE_TEXT: '추출할 텍스트 없음: 내용이 그림이나 개체 안에 있음(직접 입력하면 사용 가능)',
  LARGE_PICTURE: '텍스트나 도식이 들어 있을 수 있는 그림(자동으로 읽지 않음)',
  UNRENDERABLE_IMAGE: '브라우저가 표시할 수 없는 형식의 이미지(EMF/WMF/TIFF)',
  MISSING_MEDIA: '없거나 읽지 못한 이미지',
  SMARTART: 'SmartArt: 텍스트는 읽었지만 배치와 위계는 추정함',
  CHART_NO_DATA: '데이터를 읽지 못한 차트',
  OLE_OBJECT: '내용을 추출하지 않은 포함 개체',
  EQUATION_OBJECT: '구형 수식 개체(그림만 있고 수식 텍스트 없음)',
  MATH_PARTIAL: '일부만 변환된 수식',
  EMBEDDED_MEDIA: '포함된 동영상/오디오(추출하지 않음)',
  INK: '손글씨 잉크(추출하지 않음)',
  UNSUPPORTED_OBJECT: '지원하지 않아 추출하지 않은 개체',
  SYMBOL_FONT: '잘못 해석되었을 수 있는 기호 글꼴 문자',
  TEXT_NOT_CAPTURED: '지원하지 않는 컨테이너 속 텍스트("Unplaced text" 아래에 보관)',
  NESTING_LIMIT: '끝까지 읽지 못한 깊게 중첩된 그룹',
  HIDDEN_SHAPE: '텍스트가 있는 숨긴 도형(보관하지만 표시하지 않음)',
};

const LIMITATIONS = [
  '그림, 스크린샷, 스캔한 이미지 속 텍스트는 자동으로 읽지 않습니다. 그림에 글자가 있으면 직접 입력할 수 있고, 입력한 글자는 학습 텍스트로 쓰이며 내가 입력한 것으로 표시됩니다.',
  '슬라이드 미리보기는 파일의 XML로 다시 그린 것입니다. 글꼴, 그라데이션, 효과, SmartArt 배치는 PowerPoint와 다를 수 있으며, 추출한 텍스트가 기준입니다.',
  '애니메이션과 전환 효과는 담지 않습니다. 애니메이션이 있는 내용은 모두 나타난 상태로 추출합니다.',
  '수식은 PowerPoint 수식 형식에서 LaTeX로 최대한 변환합니다. 중요한 공식은 원본과 대조하세요.',
  '포함된 동영상, 오디오, 잉크, OLE 개체는 추출하지 않습니다.',
  '발표자 노트는 일반 텍스트로 추출합니다(서식은 빠집니다).',
];

function listSlides(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted.length > 12) return `${sorted.slice(0, 12).join(', ')} … (외 ${sorted.length - 12}장)`;
  return sorted.join(', ');
}

export function buildReport(slides: SlideData[], topics: Topic[], deckFlags: Flag[]): ExtractionReport {
  const flagsByCode: Partial<Record<FlagCode, number>> = {};
  const slidesByCode = new Map<FlagCode, number[]>();
  for (const s of slides) {
    for (const f of s.flags) {
      if (f.resolved) continue;
      flagsByCode[f.code] = (flagsByCode[f.code] ?? 0) + 1;
      const list = slidesByCode.get(f.code) ?? [];
      list.push(s.index);
      slidesByCode.set(f.code, list);
    }
  }

  const potentiallyMissing: string[] = [];
  for (const [code, label] of Object.entries(MISSING_LABEL) as [FlagCode, string][]) {
    const nums = slidesByCode.get(code);
    if (nums && nums.length > 0) {
      potentiallyMissing.push(`${label} — 슬라이드 ${listSlides(nums)}`);
    }
  }

  const sum = (pick: (s: SlideData) => number) => slides.reduce((n, s) => n + pick(s), 0);
  // Weighted: a slide whose text was read but has a diagram/picture to double-check
  // ('medium') counts for much more than one whose content is missing ('low').
  const weight: Record<Confidence, number> = { high: 1, medium: 0.75, low: 0.3 };
  const overall = slides.length === 0 ? 0 : slides.reduce((n, s) => n + weight[s.confidence], 0) / slides.length;
  const failed = slides.filter((s) => s.status === 'failed').length;
  let label: Confidence = overall >= 0.85 ? 'high' : overall >= 0.6 ? 'medium' : 'low';
  if (failed > 0 && label === 'high') label = 'medium';

  return {
    totalSlides: slides.length,
    processedSlides: slides.length - failed,
    failedSlides: failed,
    slidesRequiringAttention: slides.filter((s) => s.confidence === 'low').map((s) => s.index),
    hiddenSlides: slides.filter((s) => s.hidden).map((s) => s.index),
    tables: sum((s) => s.counts.tables),
    pictures: sum((s) => s.counts.pictures),
    charts: sum((s) => s.counts.charts),
    smartArt: sum((s) => s.counts.smartArt),
    equations: sum((s) => s.counts.equations),
    oleObjects: sum((s) => s.counts.ole),
    embeddedMedia: sum((s) => s.counts.media),
    slidesWithNotes: slides.filter((s) => s.notes.trim() !== '').length,
    topics,
    potentiallyMissing: [...potentiallyMissing, ...deckFlags.map((f) => f.message)],
    flagsByCode,
    overallConfidence: Math.round(overall * 100) / 100,
    confidenceLabel: label,
    limitations: LIMITATIONS,
  };
}

/** Slide-based lines of `potentiallyMissing` end with the slide numbers; deck-level ones do not. Reports saved before the Korean wording still say "slide". */
const SLIDE_BASED = / — (?:slides? |슬라이드 )[\d, ]+(…\s*\((?:\+\d+ more|외 \d+장)\))?$/;

/** The report again for the same deck after slides changed (for example the student typed picture text). */
export function rebuildReport(previous: ExtractionReport, slides: SlideData[]): ExtractionReport {
  const deckFlags: Flag[] = previous.potentiallyMissing.filter((m) => !SLIDE_BASED.test(m)).map((message) => ({ code: 'EXTRA_CONTENT_TYPE', severity: 'info', message }));
  return buildReport(slides, previous.topics, deckFlags);
}
