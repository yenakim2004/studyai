export type PdfErrorCode = 'NOT_PDF' | 'PDF_ENCRYPTED' | 'PDF_CORRUPT' | 'NO_PAGES' | 'FILE_TOO_LARGE' | 'TOO_MANY_PAGES';

/** A PDF that cannot be turned into a lecture. The message is what the student reads. */
export class PdfError extends Error {
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}
