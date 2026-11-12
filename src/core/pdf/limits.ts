const MiB = 1024 * 1024;

export interface PdfLimits {
  maxFileBytes: number;
  maxPages: number;
  /** Longest side of a stored page image, in pixels. */
  maxImageSide: number;
  /** Pixel budget of one page image (width × height). */
  maxImagePixels: number;
}

/**
 * Bounds for one PDF import. The original bytes, PDF.js's copy of them and one rendered page are in memory at the same time,
 * and every page image is stored on the device, so both the file and the page count are capped.
 */
export const PDF_LIMITS: Readonly<PdfLimits> = {
  maxFileBytes: 200 * MiB,
  maxPages: 500,
  maxImageSide: 2000,
  maxImagePixels: 3_000_000,
};
