import type { Box, Flag, Paragraph, PictureElement, ShapeElement, SlideData, SlideElement } from '../pptx/model';
import { elementsToStudyText } from '../pptx/shapes';

/**
 * Turns the text and the rendered image of one PDF page into a slide of the lecture model, so a PDF lecture is read, searched,
 * cited and studied exactly like a PowerPoint one. Page n is slide n. Nothing is guessed: the text is what the PDF stores,
 * in the order it stores it; only line breaks, paragraphs and the title are inferred from positions and font sizes.
 */

const EMU_PER_PT = 12700;

/** One run of text as PDF.js reports it, in points on the unrotated page view (y grows downwards, y is the baseline). */
export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  /** Font height in points. */
  size: number;
  /** The PDF ends a line after this run. */
  eol: boolean;
}

export interface PageImage {
  key: string;
  mime: string;
}

export interface PageInput {
  /** 1-based page number. */
  index: number;
  /** Page size in points, as displayed (rotation applied). */
  width: number;
  height: number;
  items: PositionedText[];
  /** The rendered page, or null when it could not be drawn. */
  image: PageImage | null;
}

/** The lecture's slide size in points: every page is fitted into it, centred, without cropping. */
export interface Frame {
  width: number;
  height: number;
}

interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
}

interface Block {
  lines: Line[];
  bullet: boolean;
  size: number;
}

const BULLET = /^([•◦▪▫‣●○■□◆◇➢➤►▶✓✔∙·]|[-–—*])\s+/u;
/** Scripts written without spaces between words: a line break inside them joins with nothing. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const PAGE_NUMBER = /^(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?$|^\d{1,4}\s*\/\s*\d{1,4}$/;
/** Code points that mean the font had no character information: private-use glyph ids or the replacement character. */
const UNDECODED = /[\uE000-\uF8FF\uFFFD]/gu;

function linesOf(items: PositionedText[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | undefined;
  let breakNext = false;
  for (const it of items) {
    const str = it.str.replace(/\s+/g, ' ');
    if (str.trim() === '') {
      if (str && cur && !breakNext) cur.text += ' ';
      if (it.eol) breakNext = true;
      continue;
    }
    const size = it.size > 0 ? it.size : (cur?.size ?? 10);
    const sameLine = cur && !breakNext && Math.abs(it.y - cur.y) <= 0.5 * Math.max(size, cur.size);
    if (cur && sameLine) {
      const gap = it.x - cur.right;
      if (gap > 0.2 * size && !/\s$/.test(cur.text) && !/^\s/.test(str)) cur.text += ' ';
      cur.text += str;
      cur.right = Math.max(cur.right, it.x + it.width);
      cur.size = Math.max(cur.size, size);
    } else {
      cur = { text: str, x: it.x, right: it.x + it.width, y: it.y, size };
      lines.push(cur);
    }
    breakNext = it.eol;
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text !== '');
}

function blocksOf(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  for (const line of lines) {
    const bullet = BULLET.test(line.text);
    const prev = cur?.lines[cur.lines.length - 1];
    const continues =
      cur &&
      prev &&
      !bullet &&
      Math.abs(line.size - cur.size) <= 0.2 * cur.size &&
      line.y - prev.y > 0 &&
      line.y - prev.y <= 1.6 * Math.max(line.size, prev.size) &&
      Math.abs(line.x - cur.lines[0]!.x) <= 4 * line.size;
    if (cur && continues) cur.lines.push(line);
    else {
      cur = { lines: [line], bullet, size: line.size };
      blocks.push(cur);
    }
  }
  return blocks;
}

function joinLines(lines: Line[]): string {
  let out = '';
  for (const { text } of lines) {
    if (!out) out = text;
    else if (out.endsWith('-') || (NO_SPACE_SCRIPT.test(out.slice(-1)) && NO_SPACE_SCRIPT.test(text[0] ?? ''))) out += text;
    else out += ` ${text}`;
  }
  return out;
}

function paragraphOf(block: Block, scale: number, leftmost: number): Paragraph {
  const raw = joinLines(block.lines);
  const text = block.bullet ? raw.replace(BULLET, '') : raw;
  const x = block.lines[0]!.x;
  const level = block.bullet ? Math.max(0, Math.min(4, Math.round((x - leftmost) / (1.8 * block.size)))) : 0;
  const size = Math.round(block.size * scale * 10) / 10;
  return { level, bullet: block.bullet ? 'bullet' : 'none', inlines: [{ kind: 'text', text, size }], text };
}

function boxOf(blocks: Block[], place: (x: number, y: number) => [number, number], scale: number): Box {
  const lines = blocks.flatMap((b) => b.lines);
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.right));
  const top = Math.min(...lines.map((l) => l.y - l.size));
  const bottom = Math.max(...lines.map((l) => l.y + 0.3 * l.size));
  const [x, y] = place(left, top);
  return { x, y, w: Math.max(1, (right - left) * scale * EMU_PER_PT), h: Math.max(1, (bottom - top) * scale * EMU_PER_PT) };
}

/** A clearly bigger line near the top of the page is its title; a page of uniform text has none. */
function titleBlock(blocks: Block[], pageHeight: number): Block | undefined {
  if (blocks.length < 2) return undefined;
  const weighted = blocks.flatMap((b) => b.lines.map((l) => ({ size: b.size, chars: l.text.length }))).sort((a, b) => a.size - b.size);
  const total = weighted.reduce((n, w) => n + w.chars, 0);
  let seen = 0;
  const median = weighted.find((w) => (seen += w.chars) >= total / 2)?.size ?? 0;
  const candidates = blocks.slice(0, 3).filter((b) => b.lines[0]!.y <= pageHeight * 0.35 && joinLines(b.lines).length <= 200);
  const biggest = candidates.sort((a, b) => b.size - a.size)[0];
  return biggest && biggest.size >= 1.25 * median ? biggest : undefined;
}

function isPageNumber(block: Block, pageHeight: number): boolean {
  const y = block.lines[0]!.y;
  return block.lines.length === 1 && PAGE_NUMBER.test(block.lines[0]!.text) && (y >= pageHeight * 0.9 || y <= pageHeight * 0.08);
}

function shape(id: string, name: string, role: ShapeElement['role'], paragraphs: Paragraph[], box: Box, z: number, decorative = false): ShapeElement {
  return { kind: 'shape', id, name, z, box, geom: 'rect', role, isTextBox: true, paragraphs, anchor: 'top', textLayer: true, ...(decorative ? { decorative: true } : {}) };
}

export const PAGE_PICTURE_ID = 'pdf-page';

export function pageSlide(page: PageInput, frame: Frame): SlideData {
  const scale = Math.min(frame.width / page.width, frame.height / page.height);
  const offX = (frame.width - page.width * scale) / 2;
  const offY = (frame.height - page.height * scale) / 2;
  const place = (x: number, y: number): [number, number] => [(offX + x * scale) * EMU_PER_PT, (offY + y * scale) * EMU_PER_PT];
  const n = page.index;

  const lines = linesOf(page.items);
  const all = blocksOf(lines);
  const furniture = all.filter((b) => isPageNumber(b, page.height));
  const content = all.filter((b) => !furniture.includes(b));
  const title = titleBlock(content, page.height);
  const body = content.filter((b) => b !== title);
  const leftmost = Math.min(...body.map((b) => b.lines[0]!.x));

  const elements: SlideElement[] = [];
  if (title) elements.push(shape('pdf-title', '제목', 'title', [{ ...paragraphOf(title, scale, title.lines[0]!.x), bullet: 'none', level: 0 }], boxOf([title], place, scale), elements.length));
  if (body.length) elements.push(shape('pdf-body', '본문', 'body', body.map((b) => paragraphOf(b, scale, leftmost)), boxOf(body, place, scale), elements.length));
  if (furniture.length) elements.push(shape('pdf-page-number', '쪽 번호', 'slideNumber', furniture.map((b) => paragraphOf(b, scale, 0)), boxOf(furniture, place, scale), elements.length, true));

  const hasText = content.length > 0;
  const [px, py] = place(0, 0);
  const pageBox: Box = { x: px, y: py, w: page.width * scale * EMU_PER_PT, h: page.height * scale * EMU_PER_PT };
  const flags: Flag[] = [];
  if (page.image) {
    const picture: PictureElement = {
      kind: 'picture',
      id: PAGE_PICTURE_ID,
      name: `${n}쪽 이미지`,
      z: elements.length,
      box: pageBox,
      media: page.image.key,
      mime: page.image.mime,
      renderable: true,
      coverage: (page.width * page.height * scale * scale) / (frame.width * frame.height),
      // Painted over the text shapes, which are its words; on a page without text the picture is the content itself.
      ...(hasText ? { decorative: true } : {}),
    };
    elements.push(picture);
  } else {
    flags.push({ code: 'MISSING_MEDIA', severity: 'warning', slide: n, message: '이 페이지의 이미지를 만들지 못해 추출한 글자만 보여 줍니다. 그림과 도형은 원본 PDF에서 확인하세요.' });
  }

  if (!hasText) {
    flags.push({
      code: 'NO_EXTRACTABLE_TEXT',
      severity: 'attention',
      slide: n,
      ...(page.image ? { elementId: PAGE_PICTURE_ID } : {}),
      message:
        '이 페이지에서 글자를 찾지 못했습니다. 스캔한 이미지이거나 글자가 그림으로 저장된 페이지입니다. 문자 인식(OCR)은 하지 않으므로 이 페이지의 내용은 검색, 노트, 튜터에 쓰이지 않습니다. 중요한 내용이면 직접 입력하세요.',
    });
  }

  const captured = content.reduce((s, b) => s + joinLines(b.lines), '');
  const letters = captured.replace(/\s/g, '');
  const undecoded = letters.match(UNDECODED)?.length ?? 0;
  if (letters.length > 0 && undecoded / letters.length > 0.1) {
    flags.push({ code: 'SYMBOL_FONT', severity: 'warning', slide: n, message: '이 페이지의 일부 글자가 깨진 채로 추출되었을 수 있습니다(글꼴에 문자 정보가 없음). 원본 PDF와 비교해 확인하세요.' });
  }

  const rawChars = page.items.reduce((s, it) => s + it.str.replace(/\s/g, '').length, 0);
  const frameHeight = frame.height * EMU_PER_PT;
  return {
    index: n,
    slideId: n,
    part: `pdf/page/${n}`,
    hidden: false,
    status: 'ok',
    title: title ? joinLines(title.lines) : '',
    elements,
    notes: '',
    text: elementsToStudyText(elements, frameHeight),
    flags,
    confidence: 'high',
    counts: { tables: 0, pictures: hasText ? 0 : 1, charts: 0, smartArt: 0, equations: 0, ole: 0, media: 0, shapes: elements.filter((e) => e.kind === 'shape').length },
    hasAnimations: false,
    coverage: { rawChars, capturedChars: rawChars, missing: [] },
  };
}

export function failedPageSlide(index: number, reason: string): SlideData {
  return {
    index,
    slideId: index,
    part: `pdf/page/${index}`,
    hidden: false,
    status: 'failed',
    title: '',
    elements: [],
    notes: '',
    text: '',
    flags: [{ code: 'SLIDE_PARSE_FAILED', severity: 'attention', slide: index, message: `이 페이지를 읽지 못했습니다(${reason}). 이 페이지의 내용은 쓸 수 없으니 원본 PDF에서 확인하세요.` }],
    confidence: 'low',
    counts: { tables: 0, pictures: 0, charts: 0, smartArt: 0, equations: 0, ole: 0, media: 0, shapes: 0 },
    hasAnimations: false,
    coverage: { rawChars: 0, capturedChars: 0, missing: [] },
  };
}
