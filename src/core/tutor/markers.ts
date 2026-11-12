/**
 * Words the tutor's answer starts a paragraph with, so the app can tell what came from the slides. The prompt asks for the
 * Korean form; the English form is still read because a model sometimes falls back to it.
 */
export const OUTSIDE_MARKER = '슬라이드 밖 내용:';
export const NOT_COVERED_MARKER = '이 슬라이드에서 다루지 않음:';

export const OUTSIDE_RE = /(^|\n)\s*\**(?:beyond the slides|슬라이드 밖 내용)\s*:/i;
export const NOT_COVERED_RE = /(^|\n)\s*\**(?:not covered on these slides|이 슬라이드에서 다루지 않음)\s*:/i;
/** A paragraph that starts with the outside marker. */
export const OUTSIDE_PARAGRAPH_RE = /^\s*\**(?:beyond the slides|슬라이드 밖 내용)\s*:/i;
