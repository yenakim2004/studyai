import { META_CSP } from './headers.ts';

/**
 * The static demo is served by GitHub Pages, which cannot send response headers, so the policy travels inside the page.
 * It must come before every script and stylesheet; the charset declaration stays first, as browsers require. Fails the build
 * when a marker is missing, so a changed index.html can never ship a demo without a policy.
 */
const CHARSET = '<meta charset="UTF-8" />';
const TITLE = '<title>StudyAI</title>';

export function injectDemoHead(html: string): string {
  for (const marker of [CHARSET, TITLE]) if (!html.includes(marker)) throw new Error(`index.html must contain ${marker} so the demo can adapt it.`);
  const tags = [`<meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`, '<meta name="referrer" content="no-referrer" />'];
  const described = html.replace(TITLE, () => '<title>StudyAI 체험판</title>\n    <meta name="description" content="예제 강의로 자료 보기, 검색, 암기 카드와 모의시험을 체험하세요. 자료를 서버에 업로드하지 않으며 AI 연결은 제공하지 않습니다." />');
  return described.replace(CHARSET, () => [CHARSET, ...tags].join('\n    '));
}

export function injectSitesHead(html: string): string {
  if (!html.includes(CHARSET)) throw new Error('Sites 빌드에 charset 표지가 없습니다.');
  const tags = [`<meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`, '<meta name="referrer" content="no-referrer" />', '<meta name="description" content="PPTX와 PDF 강의 자료로 공부하는 한국어 학습 도우미. 자료와 학습 기록은 이 브라우저에 저장됩니다." />'];
  return html.replace(CHARSET, () => [CHARSET, ...tags].join('\n    '));
}

/** The sub-path the demo is served from (GitHub Pages: /<repository>/). Always starts and ends with a slash. */
export function demoBase(value = process.env['STUDYAI_DEMO_BASE']): string {
  const base = value && value.length > 0 ? value : '/studyai/';
  const dots = base.split('/').some((part) => part === '.' || part === '..');
  if (dots || !/^\/([A-Za-z0-9._~-]+\/)*$/.test(base)) throw new Error(`STUDYAI_DEMO_BASE must look like /name/ (got "${base}").`);
  return base;
}
