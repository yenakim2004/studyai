import { getDocument, PDFDateString, PDFWorker, Util, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { sha256Hex } from '../pptx/hash';
import type { DeckMeta, Flag, MediaAsset, ParsedDeck, SlideData } from '../pptx/model';
import { buildReport, scoreSlide } from '../pptx/report';
import { detectTopics } from '../pptx/topics';
import { PdfError } from './errors';
import { failedPageSlide, pageSlide, type Frame, type PositionedText } from './layout';
import { PDF_LIMITS, type PdfLimits } from './limits';

/** The kinds of built-in data PDF.js asks for while reading a file (character maps for CJK fonts, the 14 standard fonts, image decoders). */
export type PdfAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

/** What a page image is drawn with. The browser draws on a canvas; tests pass a stand-in. */
export type PageRasterizer = (page: PDFPageProxy, scale: number, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>;

/** Everything parsePdf needs from its surroundings, so the same code runs in the browser and in tests. */
export interface PdfEnvironment {
  loadAsset(kind: PdfAssetKind, filename: string): Promise<Uint8Array>;
  rasterize: PageRasterizer;
  /** A dedicated PDF.js worker; omitted where PDF.js runs its own (Node). */
  createWorker?: () => Worker;
}

export interface PdfParseOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  limits?: Partial<PdfLimits>;
}

export const PDF_LIMITATIONS = [
  '스캔한 페이지와 그림 속 글자는 읽지 않습니다(문자 인식 없음). 글자가 없는 페이지도 이미지로 보여 주며, 필요한 내용은 직접 입력해 학습에 쓸 수 있습니다.',
  '페이지 미리보기는 PDF를 그대로 그린 이미지입니다. 추출한 글자는 PDF 안에 저장된 텍스트이고, 줄 나눔, 문단, 제목, 읽는 순서는 위치와 글자 크기로 추정한 것입니다.',
  '표, 수식, 도형의 구조는 복원하지 않고 그 안의 글자만 추출합니다. 중요한 수식과 표는 원본과 비교해 확인하세요.',
  '링크, 주석 메모, 양식 필드, 첨부 파일, 스크립트는 가져오지 않습니다.',
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function hasPdfHeader(bytes: Uint8Array): boolean {
  // The header may follow some junk bytes; readers accept it within the first kilobyte.
  const end = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= end; i++) if (PDF_MAGIC.every((b, k) => bytes[i + k] === b)) return true;
  return false;
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('가져오기를 취소했습니다.', 'AbortError');
}

function openError(err: unknown): Error {
  const name = err instanceof Error ? err.name : '';
  if (name === 'PasswordException') {
    return new PdfError('PDF_ENCRYPTED', '암호로 보호된 PDF입니다. PDF 뷰어에서 암호를 해제한 사본을 저장한 뒤 그 파일을 올려 주세요.');
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException' || name === 'UnknownErrorException' || name === 'FormatError') {
    return new PdfError('PDF_CORRUPT', 'PDF 파일이 손상되었거나 구조를 읽을 수 없습니다. 원본을 다시 내려받거나 PDF 뷰어에서 "다른 이름으로 저장"한 사본을 올려 주세요.');
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isoDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return PDFDateString.toDateObject(raw)?.toISOString();
}

function text(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 1_000) : undefined;
}

async function positionedText(page: PDFPageProxy): Promise<PositionedText[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const out: PositionedText[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const t: number[] = Util.transform(viewport.transform, item.transform);
    out.push({ str: item.str, x: t[4]!, y: t[5]!, width: item.width, size: Math.hypot(t[2]!, t[3]!), eol: item.hasEOL });
  }
  return out;
}

/** Top-level bookmarks become sections, so the lecture's topics follow the document's own table of contents. */
async function outlineSections(doc: PDFDocumentProxy): Promise<DeckMeta['sections']> {
  const outline = (await doc.getOutline().catch(() => null)) ?? [];
  const starts: { name: string; page: number }[] = [];
  for (const node of outline.slice(0, 200)) {
    try {
      const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
      const ref = dest?.[0];
      const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : undefined;
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < doc.numPages && node.title.trim()) {
        starts.push({ name: node.title.trim().slice(0, 1_000), page: index + 1 });
      }
    } catch {
      // A bookmark that points nowhere names no section.
    }
  }
  starts.sort((a, b) => a.page - b.page);
  // Several headings often start on the same page (Word and LaTeX exports): they open one section together.
  const merged = starts.reduce<typeof starts>((out, s) => {
    const last = out[out.length - 1];
    if (last?.page === s.page) last.name = `${last.name} · ${s.name}`.slice(0, 1_000);
    else out.push({ ...s });
    return out;
  }, []);
  return merged.map((s, i) => {
    const end = (merged[i + 1]?.page ?? doc.numPages + 1) - 1;
    const pages = Array.from({ length: Math.max(0, end - s.page + 1) }, (_, k) => s.page + k);
    return { name: s.name, slideIds: pages.length ? pages : [s.page] };
  });
}

/**
 * Reads a PDF into the lecture model: one slide per page with its text (for reading, search, notes and the tutor) and its
 * rendered image (for display). Pages without any text are kept, shown and flagged; their words are never invented.
 */
export async function parsePdf(bytes: Uint8Array, env: PdfEnvironment, options: PdfParseOptions = {}): Promise<ParsedDeck> {
  const limits = { ...PDF_LIMITS, ...options.limits };
  const { signal } = options;
  if (bytes.length > limits.maxFileBytes) {
    throw new PdfError('FILE_TOO_LARGE', `이 파일은 ${(bytes.length / 1048576).toFixed(0)}MB입니다. PDF는 ${limits.maxFileBytes / 1048576}MB까지 가져올 수 있으니 파일을 나누어 올려 주세요.`);
  }
  if (!hasPdfHeader(bytes)) throw new PdfError('NOT_PDF', '이 파일은 PDF 형식이 아닙니다. 확장자만 .pdf로 바뀐 파일인지 확인해 주세요.');
  aborted(signal);
  const fileHash = await sha256Hex(bytes);

  const failedAssets = new Set<string>();
  class LocalAssets {
    async fetch({ kind, filename }: { kind: PdfAssetKind; filename: string }): Promise<Uint8Array> {
      try {
        return await env.loadAsset(kind, filename);
      } catch (err) {
        failedAssets.add(filename);
        throw err;
      }
    }
  }

  const port = env.createWorker?.();
  const worker = port ? PDFWorker.create({ port }) : undefined;
  const task = getDocument({
    // PDF.js takes ownership of the buffer it is given; the caller keeps the original bytes to store them.
    data: bytes.slice(),
    ...(worker ? { worker } : {}),
    BinaryDataFactory: LocalAssets,
    useWorkerFetch: false,
    // Names only: every file is served by LocalAssets from the app's own bundle, never fetched from these addresses.
    cMapUrl: 'bundled/',
    standardFontDataUrl: 'bundled/',
    wasmUrl: 'bundled/',
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const cancel = () => void task.destroy();
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (err) {
      aborted(signal);
      throw openError(err);
    }
    const total = doc.numPages;
    if (total === 0) throw new PdfError('NO_PAGES', '이 PDF에는 페이지가 없습니다.');
    if (total > limits.maxPages) {
      throw new PdfError('TOO_MANY_PAGES', `이 PDF는 ${total}쪽입니다. 한 번에 ${limits.maxPages}쪽까지 가져올 수 있으니 PDF를 나누어 올려 주세요.`);
    }

    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const frame: Frame = { width: first.width, height: first.height };
    const slides: SlideData[] = [];
    const media = new Map<string, MediaAsset>();
    options.onProgress?.(0, total);

    for (let n = 1; n <= total; n++) {
      aborted(signal);
      let page: PDFPageProxy | undefined;
      try {
        page = await doc.getPage(n);
        const view = page.getViewport({ scale: 1 });
        const items = await positionedText(page);
        const scale = Math.min(limits.maxImageSide / Math.max(view.width, view.height), Math.sqrt(limits.maxImagePixels / (view.width * view.height)));
        let image: { key: string; mime: string } | null = null;
        try {
          const raster = await env.rasterize(page, scale, signal);
          // The key names the image's content: words typed for a scanned page carry over to a newer file only if the page looks the same.
          const key = `pdf/page-${String(n).padStart(4, '0')}-${(await sha256Hex(raster.bytes)).slice(0, 12)}.${raster.mime.split('/')[1] ?? 'img'}`;
          media.set(key, { key, mime: raster.mime, bytes: raster.bytes });
          image = { key, mime: raster.mime };
        } catch {
          aborted(signal);
        }
        const slide = pageSlide({ index: n, width: view.width, height: view.height, items, image }, frame);
        slides.push({ ...slide, confidence: scoreSlide(slide) });
      } catch (err) {
        aborted(signal);
        slides.push(failedPageSlide(n, err instanceof Error ? err.message.slice(0, 200) : '알 수 없는 오류'));
      } finally {
        page?.cleanup();
      }
      options.onProgress?.(n, total);
    }

    const info = ((await doc.getMetadata().catch(() => null))?.info ?? {}) as Record<string, unknown>;
    const meta: DeckMeta = {
      format: 'pdf',
      slideWidth: Math.round(frame.width * 12700),
      slideHeight: Math.round(frame.height * 12700),
      slideCount: total,
      sections: await outlineSections(doc),
    };
    const title = text(info['Title']);
    const author = text(info['Author']);
    const created = isoDate(info['CreationDate']);
    const modified = isoDate(info['ModDate']);
    const application = text(info['Creator']) ?? text(info['Producer']);
    if (title) meta.title = title;
    if (author) meta.author = author;
    if (created) meta.created = created;
    if (modified) meta.modified = modified;
    if (application) meta.application = application.slice(0, 200);

    const flags: Flag[] = failedAssets.size
      ? [{ code: 'EXTRA_CONTENT_TYPE', severity: 'warning', message: 'PDF를 읽는 데 필요한 글꼴 자료 일부를 불러오지 못해 일부 글자나 그림이 빠졌을 수 있습니다. 원본 PDF와 비교해 확인하세요.' }]
      : [];
    const report = { ...buildReport(slides, detectTopics(slides, meta.sections), flags), limitations: PDF_LIMITATIONS };
    return { meta, slides, media, report, fileHash, fileSize: bytes.length, flags };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await task.destroy().catch(() => undefined);
    worker?.destroy();
    port?.terminate();
  }
}
