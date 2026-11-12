import type { Topic } from '../pptx/model';

/**
 * A guided lesson: the lecture's own topics, in slide order, cut into parts small enough to send together. Nothing is
 * invented: a part is just a range of existing slides under the deck's own topic titles.
 */
export interface LessonPart {
  /** 1-based position in the lesson. */
  n: number;
  /** The deck's own topic title(s) this part covers, in order. */
  topic: string;
  title: string;
  /** Inclusive 1-based slide range. */
  start: number;
  end: number;
  slides: number[];
}

interface Chunk {
  topic: string;
  start: number;
  end: number;
  /** Set when the chunk is one of several cut from a single long topic. */
  piece?: [number, number];
}

/** Splits a range of slides into the fewest chunks of at most `max`, as even as possible. */
function cut(start: number, end: number, max: number): [number, number][] {
  const count = end - start + 1;
  const n = Math.max(1, Math.ceil(count / max));
  const base = Math.floor(count / n);
  const extra = count % n;
  const out: [number, number][] = [];
  let at = start;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push([at, at + size - 1]);
    at += size;
  }
  return out;
}

const range = (a: number, b: number): string => (a === b ? `슬라이드 ${a}` : `슬라이드 ${a}–${b}`);

export function lessonParts(topics: readonly Pick<Topic, 'title' | 'startSlide' | 'endSlide'>[], slideCount: number, maxSlides = 4): LessonPart[] {
  const usable = topics.filter((t) => t.startSlide >= 1 && t.endSlide >= t.startSlide && t.endSlide <= slideCount).sort((a, b) => a.startSlide - b.startSlide);
  // Without usable topics the lesson simply walks through the slides in order.
  const source = usable.length > 0 ? usable : slideCount > 0 ? [{ title: '강의 전체', startSlide: 1, endSlide: slideCount }] : [];

  // 1. every topic is cut into chunks of at most `maxSlides`
  const chunks: Chunk[] = source.flatMap((t) => {
    const pieces = cut(t.startSlide, t.endSlide, maxSlides);
    return pieces.map(([start, end], i): Chunk => ({ topic: t.title, start, end, ...(pieces.length > 1 ? { piece: [i + 1, pieces.length] as [number, number] } : {}) }));
  });

  // 2. neighbouring small chunks are packed together while they still fit, so a lesson is not one request per slide
  const groups: Chunk[][] = [];
  for (const c of chunks) {
    const last = groups[groups.length - 1];
    const lastSpan = last ? last[last.length - 1]!.end - last[0]!.start + 1 : 0;
    if (last && !c.piece && !last[last.length - 1]!.piece && lastSpan + (c.end - c.start + 1) <= maxSlides) last.push(c);
    else groups.push([c]);
  }

  return groups.map((g, i) => {
    const start = g[0]!.start;
    const end = g[g.length - 1]!.end;
    const names = [...new Set(g.map((c) => c.topic))];
    const topic = names.join(' · ');
    // the list shows at most two topic names; the question to the tutor carries them all
    const shown = names.length > 2 ? `${names[0]} · ${names[1]} 외 ${names.length - 2}개` : topic;
    const piece = g.length === 1 ? g[0]!.piece : undefined;
    return {
      n: i + 1,
      topic,
      title: piece ? `${shown} (${piece[1]}부분 중 ${piece[0]}, ${range(start, end)})` : `${shown} (${range(start, end)})`,
      start,
      end,
      slides: Array.from({ length: end - start + 1 }, (_, k) => start + k),
    };
  });
}

/**
 * The question that starts a lesson part. The student sees it, can change it, and sends it. A later part names the parts that were
 * really taught before it, so it connects to them even when the earlier answers are no longer part of the chat the server sees.
 */
export function lessonQuestion(part: LessonPart, first: boolean, covered: readonly LessonPart[] = []): string {
  const where = range(part.start, part.end);
  if (first) return `"${part.topic}"(${where})을(를) 내가 아직 아무것도 모른다고 생각하고 처음부터 슬라이드 순서대로 가르쳐 주세요. 이 슬라이드만 사용하세요. 슬라이드가 설명하지 않는 부분은 그렇다고 말해 주세요.`;
  const recent = covered.slice(-5).map((p) => `${p.topic} (${range(p.start, p.end)})`);
  const older = covered.length > 5 ? `앞선 ${covered.length - 5}개 부분과 ` : '';
  const memory = recent.length > 0 ? ` (지금까지 ${older}${recent.join('; ')}을(를) 배웠습니다.)` : '';
  return `이제 다음 부분 "${part.topic}"(${where})을(를) 슬라이드 순서대로 가르쳐 주세요. 지금까지 배운 내용과 연결해 주세요${memory}. 이 슬라이드만 사용하세요. 슬라이드가 설명하지 않는 부분은 그렇다고 말해 주세요.`;
}
