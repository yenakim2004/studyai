export type PptxErrorCode =
  | 'NOT_A_ZIP'
  | 'LEGACY_PPT'
  | 'ENCRYPTED'
  | 'NOT_PPTX'
  | 'FILE_TOO_LARGE'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_TOTAL_TOO_LARGE'
  | 'ZIP_RATIO_SUSPICIOUS'
  | 'ZIP_BAD_ENTRY'
  | 'ZIP_UNSUPPORTED'
  | 'ZIP_DUPLICATE_ENTRY'
  | 'ZIP_OVERLAP'
  | 'ZIP_SIZE_MISMATCH'
  | 'ZIP_CRC_MISMATCH'
  | 'XML_FORBIDDEN_DTD'
  | 'XML_TOO_LARGE'
  | 'XML_MALFORMED'
  | 'TOO_MANY_SLIDES';

/** Error raised for any file that is rejected as unsafe, unsupported or corrupt. */
export class PptxError extends Error {
  readonly code: PptxErrorCode;

  constructor(code: PptxErrorCode, message: string) {
    super(message);
    this.name = 'PptxError';
    this.code = code;
  }
}

/** User-facing explanation for a rejected file. */
export function describePptxError(err: unknown): string {
  if (err instanceof PptxError) {
    switch (err.code) {
      case 'LEGACY_PPT':
        return '오래된 .ppt 파일입니다. PowerPoint에서 열어 다른 이름으로 저장 → PowerPoint 프레젠테이션(.pptx)으로 저장한 뒤 그 파일을 올리세요.';
      case 'ENCRYPTED':
        return '암호로 보호된 프레젠테이션입니다. PowerPoint에서 암호를 해제하고(파일 → 정보 → 프레젠테이션 보호) 사본을 저장하세요.';
      case 'NOT_A_ZIP':
      case 'NOT_PPTX':
        return '올바른 .pptx 프레젠테이션 파일이 아닙니다.';
      case 'FILE_TOO_LARGE':
        return '브라우저에서 안전하게 처리할 수 있는 크기보다 큰 파일입니다.';
      default:
        return `안전 또는 무결성 문제로 파일을 거부했습니다(${err.code}): ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : '파일을 읽는 중 알 수 없는 오류가 발생했습니다.';
}
