import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ParsedDeck } from '../pptx/model';
import { parsePdf, type PdfAssetKind, type PdfEnvironment, type PdfParseOptions } from './parse';

/**
 * PDF.js's built-in data, bundled with the app (same origin, no CDN): character maps for CJK and other legacy fonts, the
 * Symbol/Dingbats fonts, and the JBIG2 / JPEG 2000 / colour-profile decoders. Each file is emitted as its own hashed asset;
 * the table maps the name PDF.js asks for to that asset's URL, and nothing is downloaded until a PDF needs it. The Liberation
 * fonts are left out: with system fonts enabled (the browser default) PDF.js asks for them only for XFA forms, which are off.
 */
const urls = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

const ASSETS: Record<PdfAssetKind, Map<string, string>> = {
  cMapUrl: urls(import.meta.glob<string>('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true })),
  standardFontDataUrl: urls(import.meta.glob<string>('../../../node_modules/pdfjs-dist/standard_fonts/*.pfb', { query: '?url', import: 'default', eager: true })),
  wasmUrl: urls(import.meta.glob<string>('../../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm', { query: '?url', import: 'default', eager: true })),
};

async function loadAsset(kind: PdfAssetKind, filename: string): Promise<Uint8Array> {
  const url = ASSETS[kind].get(filename);
  if (!url) throw new Error(`PDF.js asked for ${filename}, which is not bundled.`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${filename}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function rasterize(page: PDFPageProxy, scale: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas, viewport, intent: 'display' });
  const stop = () => task.cancel();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await task.promise;
    // WebP keeps text pages sharp at a fraction of PNG's size; browsers that cannot encode it hand back PNG, so fall back to JPEG.
    let blob = await toBlob(canvas, 'image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.88);
    if (!blob) throw new Error('page image could not be encoded');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
  } finally {
    signal?.removeEventListener('abort', stop);
    // Release the bitmap now: a long PDF would otherwise keep hundreds of page-sized canvases alive until garbage collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

const browserEnvironment: PdfEnvironment = {
  loadAsset,
  rasterize,
  createWorker: () => new Worker(workerUrl, { type: 'module' }),
};

export function parsePdfInBrowser(bytes: Uint8Array, options: PdfParseOptions): Promise<ParsedDeck> {
  return parsePdf(bytes, browserEnvironment, options);
}
