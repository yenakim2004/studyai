import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PdfError } from '../src/core/pdf';
import { parsePdf, type PdfEnvironment } from '../src/core/pdf/parse';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadMedia, loadSlides, replaceLecture, setPictureText } from '../src/core/db/library';
import { applyBackup, exportBackup, readBackup } from '../src/core/backup/backup';
import { deckMetaSchema, slideSchema } from '../src/core/db/schemas';
import { SearchIndex } from '../src/core/search/search';
import { buildContext, slideContextText } from '../src/core/tutor/context';
import { displayTitle } from '../src/core/pptx/topics';
import { pdfWithBookmarkTarget } from './fixtures/pdf-bookmark';

const FIXTURES = fileURLToPath(new URL('./fixtures/pdf/', import.meta.url));
const PDFJS = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const FOLDER = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${FIXTURES}${name}`));
}

/** Node stand-in for the browser: PDF.js's own data files from node_modules, and a page "image" that records the call. */
function nodeEnv(overrides: Partial<PdfEnvironment> = {}, look = 0): PdfEnvironment & { rendered: number[] } {
  const rendered: number[] = [];
  return {
    rendered,
    loadAsset: async (kind, filename) => new Uint8Array(await readFile(`${PDFJS}${FOLDER[kind]}/${filename}`)),
    rasterize: async (page, scale) => {
      expect(scale).toBeGreaterThan(0);
      rendered.push(page.pageNumber);
      return { bytes: Uint8Array.from([...PNG, page.pageNumber, look]), mime: 'image/png' };
    },
    ...overrides,
  };
}

describe('a PDF with text becomes a lecture whose pages are its slides', () => {
  it('keeps every page in order with its own text, title and image', async () => {
    const bytes = await fixture('text-lecture.pdf');
    const env = nodeEnv();
    const deck = await parsePdf(bytes, env);

    expect(deck.meta.format).toBe('pdf');
    expect(deck.meta.title).toBe('운영체제 3강');
    expect(deck.slides.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(env.rendered).toEqual([1, 2, 3]);
    expect([...deck.media.keys()]).toEqual([expect.stringMatching(/^pdf\/page-0001-[0-9a-f]{12}\.png$/), expect.stringMatching(/^pdf\/page-0002-/), expect.stringMatching(/^pdf\/page-0003-/)]);

    const [p1, p2, p3] = deck.slides;
    expect(p1!.title).toBe('프로세스 스케줄링');
    expect(p1!.text).toContain('선점형 스케줄링은 실행 중인 프로세스를 중단시킬 수 있다');
    expect(p1!.text).toContain('라운드 로빈은 시간 할당량(time quantum)을 사용한다');
    // The three bullets stay three items, in the order of the page.
    expect(p1!.text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
    expect(p1!.text.indexOf('선점형')).toBeLessThan(p1!.text.indexOf('문맥 교환'));
    // The page number in the corner is furniture, not study text.
    expect(p1!.text).not.toMatch(/(^|\n)1$/);
    expect(p1!.confidence).toBe('high');

    expect(p2!.title).toBe('교착 상태의 네 가지 조건');
    expect(p2!.text).toContain('상호 배제, 점유 대기, 비선점, 순환 대기가 동시에 성립하면 교착 상태가 발생할 수 있다.');
    expect(p2!.text).toContain('Deadlock requires all four Coffman conditions.');

    // The text pages show the page image over their (invisible) text; the image-only page shows it as its content.
    const picture = (s: typeof p1) => s!.elements.find((e) => e.kind === 'picture');
    expect(picture(p1)).toMatchObject({ media: [...deck.media.keys()][0], decorative: true });
    expect(p1!.elements.filter((e) => e.kind === 'shape' && !e.decorative).every((e) => e.kind === 'shape' && e.textLayer)).toBe(true);
    expect(picture(p3)?.decorative).toBeUndefined();
    expect(p3!.text).toBe('');
    expect(p3!.flags.map((f) => f.code)).toContain('NO_EXTRACTABLE_TEXT');
    expect(deck.report.slidesRequiringAttention).toEqual([3]);
  });

  it('takes its topics from the bookmarks and keeps the original bytes intact', async () => {
    const bytes = await fixture('text-lecture.pdf');
    const before = createHash('sha256').update(bytes).digest('hex');
    const deck = await parsePdf(bytes, nodeEnv());
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(deck.fileHash).toBe(before);
    expect(deck.fileSize).toBe(bytes.byteLength);
    expect(deck.report.topics.map((t) => [t.title, t.startSlide, t.endSlide])).toEqual([
      ['스케줄링', 1, 1],
      ['교착 상태', 2, 3],
    ]);
  });

  it('merges bookmarks that start on the same page into one topic', async () => {
    const deck = await parsePdf(await fixture('shared-bookmarks.pdf'), nodeEnv());
    expect(deck.report.topics.map((t) => [t.title, t.startSlide, t.endSlide])).toEqual([
      ['Intro · Overview', 1, 1],
      ['Part A · Part B', 2, 2],
      ['Part C', 3, 3],
    ]);
  });

  it('feeds search and the tutor with the page text, cited by page number', async () => {
    const deck = await parsePdf(await fixture('text-lecture.pdf'), nodeEnv());
    const index = new SearchIndex();
    index.addLecture({ id: 'L', courseId: 'C', title: '운영체제 3강' }, '운영체제', deck.slides);
    const hits = index.search('순환 대기');
    expect(hits[0]).toMatchObject({ lectureId: 'L', slide: 2 });
    expect(index.search('라운드 로빈')[0]?.slide).toBe(1);

    const page2 = deck.slides[1]!;
    const context = buildContext([{ lectureId: 'L', lectureTitle: '운영체제 3강', revision: 1, slide: 2, title: displayTitle(page2), text: slideContextText(page2, deck.meta.slideHeight) }]);
    expect(context.excerpts[0]).toMatchObject({ slide: 2, title: '교착 상태의 네 가지 조건' });
    expect(context.excerpts[0]!.text).toContain('Coffman conditions');
    expect(context.refs.get('S1')).toEqual({ lectureId: 'L', slide: 2, rev: 1 });
  });

  it('survives the backup validators unchanged', async () => {
    const deck = await parsePdf(await fixture('text-lecture.pdf'), nodeEnv());
    for (const s of deck.slides) expect(slideSchema.parse(s)).toEqual(s);
    expect(deckMetaSchema.parse(deck.meta)).toEqual(deck.meta);
  });
});

describe('a scanned PDF', () => {
  it('shows every page and says its text is missing, without inventing any', async () => {
    const deck = await parsePdf(await fixture('scanned-lecture.pdf'), nodeEnv());
    expect(deck.slides).toHaveLength(2);
    for (const s of deck.slides) {
      expect(s.text).toBe('');
      expect(s.confidence).toBe('low');
      expect(s.elements).toEqual([expect.objectContaining({ kind: 'picture', renderable: true, media: expect.stringMatching(`^pdf/page-000${s.index}-`) })]);
      const flag = s.flags.find((f) => f.code === 'NO_EXTRACTABLE_TEXT');
      expect(flag?.severity).toBe('attention');
      expect(flag?.message).toContain('OCR');
    }
    expect(deck.report.slidesRequiringAttention).toEqual([1, 2]);
    expect(deck.report.limitations.join(' ')).toContain('문자 인식 없음');
  });

  it('uses the words the student types for a page as that page’s study text', async () => {
    const bytes = await fixture('scanned-lecture.pdf');
    const deck = await parsePdf(bytes, nodeEnv());
    const db = new StudyDB(`pdf-${Math.random()}`);
    const course = await createCourse(db, { name: '운영체제' });
    const lecture = await importLecture(db, { courseId: course.id, fileName: '스캔 강의.pdf', bytes, deck });
    expect(lecture.title).toBe('스캔 강의');
    expect(new Uint8Array(await (await db.files.get(lecture.id))!.blob.arrayBuffer())).toEqual(bytes);
    expect([...(await loadMedia(db, lecture.id)).keys()]).toEqual([...deck.media.keys()]);

    await setPictureText(db, lecture.id, 1, 'pdf-page', '스캔 1쪽의 내용');
    const [page1] = await loadSlides(db, lecture.id);
    expect(page1!.text).toContain('스캔 1쪽의 내용');
    expect(page1!.flags.find((f) => f.code === 'NO_EXTRACTABLE_TEXT')?.resolved).toBe(true);
    const after = await db.lectures.get(lecture.id);
    expect(after!.report.slidesRequiringAttention).toEqual([2]);
    expect(after!.report.limitations).toEqual(deck.report.limitations);
  });
});

describe('a stored PDF lecture', () => {
  it.each([-1, 0.5, 1, 9999, 4294967296])('ignores invalid bookmark target %s and still restores its backup', async (target) => {
    const bytes = pdfWithBookmarkTarget(target);
    const deck = await parsePdf(bytes, nodeEnv());
    expect(deck.meta.sections).toEqual([{ name: 'Intro', slideIds: [1] }]);
    const db = new StudyDB(`pdf-bookmark-${target}-${Math.random()}`);
    const fresh = new StudyDB(`pdf-bookmark-restored-${target}-${Math.random()}`);
    try {
      const course = await createCourse(db, { name: '북마크 검사' });
      const lecture = await importLecture(db, { courseId: course.id, fileName: 'bookmark.pdf', bytes, deck });
      const backup = readBackup(new Uint8Array(await (await exportBackup(db)).arrayBuffer()));
      await applyBackup(fresh, backup, 'replace');
      expect((await fresh.lectures.get(lecture.id))?.meta.sections).toEqual([{ name: 'Intro', slideIds: [1] }]);
      expect(await loadSlides(fresh, lecture.id)).toHaveLength(1);
    } finally {
      await db.delete();
      await fresh.delete();
    }
  });

  it('keeps its original bytes, pages and images through a backup and restore', async () => {
    const bytes = await fixture('text-lecture.pdf');
    const deck = await parsePdf(bytes, nodeEnv());
    const db = new StudyDB(`pdf-bk-${Math.random()}`);
    const course = await createCourse(db, { name: '운영체제' });
    const lecture = await importLecture(db, { courseId: course.id, fileName: '3강.pdf', bytes, deck });

    const backup = readBackup(new Uint8Array(await (await exportBackup(db)).arrayBuffer()));
    const fresh = new StudyDB(`pdf-restore-${Math.random()}`);
    await applyBackup(fresh, backup, 'replace');
    const restored = await fresh.lectures.get(lecture.id);
    expect(restored?.meta.format).toBe('pdf');
    expect(restored?.fileName).toBe('3강.pdf');
    expect(new Uint8Array(await (await fresh.files.get(lecture.id))!.blob.arrayBuffer())).toEqual(bytes);
    expect((await loadSlides(fresh, lecture.id)).map((s) => s.text)).toEqual(deck.slides.map((s) => s.text));
    expect([...(await loadMedia(fresh, lecture.id)).keys()]).toEqual([...deck.media.keys()]);
  });

  it('is replaced in place by a newer PDF, keeping the words typed for a page that did not change', async () => {
    const db = new StudyDB(`pdf-replace-${Math.random()}`);
    const course = await createCourse(db, { name: '운영체제' });
    const scanned = await fixture('scanned-lecture.pdf');
    const first = await importLecture(db, { courseId: course.id, fileName: 'lec.pdf', bytes: scanned, deck: await parsePdf(scanned, nodeEnv()) });
    await setPictureText(db, first.id, 2, 'pdf-page', '직접 입력한 2쪽');

    const text = await fixture('text-lecture.pdf');
    const next = await replaceLecture(db, first.id, { fileName: 'lec.pdf', bytes: text, deck: await parsePdf(text, nodeEnv()) });
    expect(next).toMatchObject({ id: first.id, revision: 2, slideCount: 3 });
    expect(new Uint8Array(await (await db.files.get(first.id))!.blob.arrayBuffer())).toEqual(text);
    const slides = await loadSlides(db, first.id);
    expect(slides[1]!.text).toContain('교착 상태');
    // Page 2 is now a text page: its old scan is gone, and so is the text typed for that scan.
    expect(slides[1]!.text).not.toContain('직접 입력한 2쪽');
  });

  it('carries words typed for a scanned page only to a newer file whose page looks the same', async () => {
    const db = new StudyDB(`pdf-carry-${Math.random()}`);
    const course = await createCourse(db, { name: '운영체제' });
    const scanned = await fixture('scanned-lecture.pdf');
    const lecture = await importLecture(db, { courseId: course.id, fileName: 'scan.pdf', bytes: scanned, deck: await parsePdf(scanned, nodeEnv()) });
    await setPictureText(db, lecture.id, 1, 'pdf-page', '1쪽 내용');

    await replaceLecture(db, lecture.id, { fileName: 'scan.pdf', bytes: scanned, deck: await parsePdf(scanned, nodeEnv()) });
    expect((await loadSlides(db, lecture.id))[0]!.text).toContain('1쪽 내용');

    await replaceLecture(db, lecture.id, { fileName: 'scan.pdf', bytes: scanned, deck: await parsePdf(scanned, nodeEnv({}, 1)) });
    const [page1] = await loadSlides(db, lecture.id);
    expect(page1!.text).not.toContain('1쪽 내용');
    expect(page1!.flags.find((f) => f.code === 'NO_EXTRACTABLE_TEXT')?.resolved).toBeUndefined();
  });
});

describe('PDFs that cannot be read are refused with a reason', () => {
  const codeOf = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfError);
    return (err as PdfError).code;
  };

  it('password-protected', async () => {
    expect(await codeOf(parsePdf(await fixture('encrypted.pdf'), nodeEnv()))).toBe('PDF_ENCRYPTED');
  });

  it('corrupt', async () => {
    expect(await codeOf(parsePdf(await fixture('broken.pdf'), nodeEnv()))).toBe('PDF_CORRUPT');
  });

  it('not a PDF at all', async () => {
    expect(await codeOf(parsePdf(new TextEncoder().encode('PK\u0003\u0004 not a pdf'), nodeEnv()))).toBe('NOT_PDF');
  });

  it('too large or too long', async () => {
    const bytes = await fixture('text-lecture.pdf');
    expect(await codeOf(parsePdf(bytes, nodeEnv(), { limits: { maxFileBytes: 1000 } }))).toBe('FILE_TOO_LARGE');
    expect(await codeOf(parsePdf(bytes, nodeEnv(), { limits: { maxPages: 2 } }))).toBe('TOO_MANY_PAGES');
  });
});

describe('reading a PDF', () => {
  it('stops when cancelled and draws no further page', async () => {
    const controller = new AbortController();
    const env = nodeEnv();
    const run = parsePdf(await fixture('text-lecture.pdf'), env, { signal: controller.signal, onProgress: (done) => done === 1 && controller.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.rendered).toEqual([1]);
  });

  it('keeps a page’s text when its image cannot be drawn, and says so', async () => {
    const deck = await parsePdf(await fixture('text-lecture.pdf'), nodeEnv({ rasterize: async () => Promise.reject(new Error('no canvas')) }));
    expect(deck.media.size).toBe(0);
    expect(deck.slides[0]!.text).toContain('선점형 스케줄링');
    expect(deck.slides[0]!.elements.some((e) => e.kind === 'picture')).toBe(false);
    expect(deck.slides[0]!.flags.map((f) => f.code)).toContain('MISSING_MEDIA');
  });

  it('warns when PDF.js could not load the character maps it needed', async () => {
    const deck = await parsePdf(await fixture('text-lecture.pdf'), nodeEnv({ loadAsset: async () => Promise.reject(new Error('offline')) }));
    expect(deck.report.potentiallyMissing.join(' ')).toContain('글꼴 자료');
  });
});
