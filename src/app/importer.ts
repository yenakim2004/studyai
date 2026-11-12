import { DEFAULT_LIMITS, PptxError, describePptxError, parsePptx, type PptxErrorCode } from '@/core/pptx';
import type { LectureFormat, ParsedDeck } from '@/core/pptx/model';
import { PDF_LIMITS, PdfError } from '@/core/pdf';

export interface ParsedFile {
  deck: ParsedDeck;
  bytes: Uint8Array;
}

export interface ParseFileOptions {
  onProgress?: (done: number, total: number) => void;
  /** Stops reading: the promise rejects with an AbortError and everything the reader held is released. */
  signal?: AbortSignal;
}

const LECTURE_FORMATS = ['pptx', 'pdf'] as const satisfies readonly LectureFormat[];

/** The files a lecture can be made from, by extension, and the size each reader accepts. */
const FORMATS: Record<LectureFormat, { extension: RegExp; maxBytes: number }> = {
  pptx: { extension: /\.(pptx|pptm|ppsx|potx)$/i, maxBytes: DEFAULT_LIMITS.maxFileBytes },
  pdf: { extension: /\.pdf$/i, maxBytes: PDF_LIMITS.maxFileBytes },
};

/** The file picker's `accept` value: the same extensions as FORMATS, plus the MIME types some systems filter by. */
export const ACCEPTED_FILES = '.pptx,.pptm,.ppsx,.potx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function formatOf(name: string): LectureFormat | undefined {
  return LECTURE_FORMATS.find((f) => FORMATS[f].extension.test(name));
}

export function isAcceptedFileName(name: string): boolean {
  return formatOf(name) !== undefined;
}

/** What to tell the student about a file that is not accepted. One wording, so the import list and `parseFile` agree. */
export function rejectionMessage(name: string): string {
  return /\.ppt$/i.test(name)
    ? '예전 형식의 .ppt 파일입니다. PowerPoint에서 열어 .pptx로 저장하거나 PDF로 내보낸 뒤 올려 주세요.'
    : 'PowerPoint 파일(.pptx, .pptm, .ppsx, .potx)과 PDF 파일(.pdf)만 가져올 수 있습니다.';
}

/** What the import list says about a file that failed. */
export function describeImportError(err: unknown): string {
  if (err instanceof PdfError) return err.message;
  if (err instanceof DOMException && err.name === 'AbortError') return '가져오기를 취소했습니다.';
  return describePptxError(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('가져오기를 취소했습니다.', 'AbortError');
}

function parsePptxFile(bytes: Uint8Array, { onProgress, signal }: ParseFileOptions): Promise<ParsedDeck> {
  if (typeof Worker === 'undefined') return parsePptx(bytes, { onProgress });
  return new Promise<ParsedDeck>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => {
      finish();
      reject(abortError());
    };
    signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; done?: number; total?: number; deck?: ParsedDeck; code?: PptxErrorCode | 'UNKNOWN'; message?: string };
      if (m.type === 'progress') onProgress?.(m.done ?? 0, m.total ?? 0);
      else if (m.type === 'done') {
        finish();
        resolve(m.deck!);
      } else if (m.type === 'error') {
        finish();
        reject(m.code && m.code !== 'UNKNOWN' ? new PptxError(m.code, m.message ?? '') : new Error(m.message ?? '알 수 없는 오류'));
      }
    };
    worker.onerror = (ev) => {
      finish();
      reject(new Error(ev.message || '파일을 읽는 중 오류가 나서 중단되었습니다.'));
    };
    worker.postMessage({ bytes });
  });
}

async function parsePdfFile(bytes: Uint8Array, options: ParseFileOptions): Promise<ParsedDeck> {
  // PDF.js is large: it is loaded the first time a PDF is imported, not with the app.
  const { parsePdfInBrowser } = await import('@/core/pdf/browser');
  return parsePdfInBrowser(bytes, options);
}

/** Read and parse one file. PowerPoint is parsed in a Web Worker (inline where workers are unavailable); PDF by PDF.js, which runs its own worker. */
export async function parseFile(file: File, options: ParseFileOptions = {}): Promise<ParsedFile> {
  const format = formatOf(file.name);
  if (!format) throw new Error(rejectionMessage(file.name));
  const { maxBytes } = FORMATS[format];
  if (file.size > maxBytes) {
    const message = `이 파일은 ${(file.size / 1048576).toFixed(0)}MB입니다. 이 형식은 ${maxBytes / 1048576}MB까지 가져올 수 있습니다.`;
    throw format === 'pdf' ? new PdfError('FILE_TOO_LARGE', message) : new PptxError('FILE_TOO_LARGE', message);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (options.signal?.aborted) throw abortError();
  const deck = format === 'pdf' ? await parsePdfFile(bytes, options) : await parsePptxFile(bytes, options);
  return { deck, bytes };
}
