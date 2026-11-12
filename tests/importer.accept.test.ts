import { describe, expect, it } from 'vitest';
import { ACCEPTED_FILES, describeImportError, formatOf, isAcceptedFileName, parseFile, rejectionMessage } from '@/app/importer';
import { PdfError } from '@/core/pdf';
import { PptxError } from '@/core/pptx';

describe('which files the importer accepts, and what it says when it rejects one', () => {
  it('accepts the four PowerPoint extensions and PDF, in any case', () => {
    for (const name of ['a.pptx', 'a.pptm', 'a.ppsx', 'a.potx', 'LECTURE 1.PPTX', 'x.y.Pptm']) expect(formatOf(name), name).toBe('pptx');
    for (const name of ['a.pdf', '3강 강의.PDF', 'x.y.Pdf']) expect(formatOf(name), name).toBe('pdf');
    for (const name of ['a.ppt', 'a.pot', 'a.docx', 'a.pdf.txt', 'a.pptx.txt', 'pptx', 'pdf', '']) {
      expect(isAcceptedFileName(name), name).toBe(false);
    }
  });

  it('offers exactly the accepted extensions in the file picker', () => {
    const offered = ACCEPTED_FILES.split(',').filter((t) => t.startsWith('.'));
    expect(offered.sort()).toEqual(['.pdf', '.potx', '.ppsx', '.pptm', '.pptx']);
    for (const ext of offered) expect(isAcceptedFileName(`f${ext}`), ext).toBe(true);
  });

  it('names every accepted extension, PDF included, when it rejects a file', () => {
    const message = rejectionMessage('notes.docx');
    for (const ext of ['.pptx', '.pptm', '.ppsx', '.potx', '.pdf']) expect(message).toContain(ext);
  });

  it('tells the student how to convert an old .ppt file', () => {
    expect(rejectionMessage('old.PPT')).toContain('.ppt');
    expect(rejectionMessage('old.PPT')).toContain('.pptx');
    expect(rejectionMessage('old.PPT')).toContain('PDF');
  });

  it('parseFile rejects with the same message the import list shows', async () => {
    for (const name of ['notes.docx', 'old.ppt']) {
      await expect(parseFile(new File([new Uint8Array(4)], name))).rejects.toThrow(rejectionMessage(name));
    }
  });

  it('explains PDF and cancellation failures in the import list', () => {
    expect(describeImportError(new PdfError('PDF_ENCRYPTED', '암호로 보호된 PDF입니다.'))).toBe('암호로 보호된 PDF입니다.');
    expect(describeImportError(new DOMException('x', 'AbortError'))).toBe('가져오기를 취소했습니다.');
    expect(describeImportError(new PptxError('ENCRYPTED', 'x'))).not.toBe('');
  });

  it('refuses an oversized PDF before reading it', async () => {
    const big = { name: 'big.pdf', size: 201 * 1024 * 1024, arrayBuffer: () => Promise.reject(new Error('must not be read')) } as unknown as File;
    await expect(parseFile(big)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('stops a cancelled PowerPoint read', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parseFile(new File([new Uint8Array(4)], 'a.pptx'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
