import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { titleFromFileName } from '../core/db/library';
import { parsePptx } from '../core/pptx';
import type { ParsedDeck } from '../core/pptx/model';
import { displayTitle } from '../core/pptx/topics';
import { lectureToMarkdown, studyPackPrompt, type PromptOptions } from '../core/study/markdown';
import { extractJson, planPack, type LectureContext, type PackPlan } from '../core/study/pack';
import { slideVerificationText } from '../core/study/slide-text';

/**
 * Command-line helpers for the Claude Code "lecture-pack" skill. They use exactly the same
 * extraction engine, Markdown export and pack validation as the web app, and make no network calls.
 */

export interface ExtractedLecture {
  ref: string;
  title: string;
  fileHash: string;
  slideCount: number;
  source: string;
  markdownPath: string;
  reportPath: string;
  confidence: string;
  slidesNeedingAttention: number[];
  caveats: string[];
}

const slug = (s: string) => s.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lecture';

async function load(file: string): Promise<{ deck: ParsedDeck; title: string }> {
  const deck = await parsePptx(new Uint8Array(readFileSync(file)));
  return { deck, title: titleFromFileName(basename(file)) };
}

/** Extract lectures to Markdown (with stable refs L1, L2…) plus a completeness report for each. */
export async function extractLectures(files: string[], outDir: string): Promise<ExtractedLecture[]> {
  mkdirSync(outDir, { recursive: true });
  const out: ExtractedLecture[] = [];
  for (const [i, file] of files.entries()) {
    const ref = `L${i + 1}`;
    const { deck, title } = await load(file);
    const md = lectureToMarkdown({ title, fileHash: deck.fileHash, slideCount: deck.slides.length, meta: deck.meta }, deck.slides, ref);
    const name = `${ref}-${slug(title)}`;
    const markdownPath = join(outDir, `${name}.md`);
    const reportPath = join(outDir, `${name}.report.json`);
    writeFileSync(markdownPath, md, 'utf8');
    writeFileSync(reportPath, JSON.stringify({ ref, title, fileHash: deck.fileHash, report: deck.report, slides: deck.slides.map((s) => ({ index: s.index, title: displayTitle(s), confidence: s.confidence, flags: s.flags.filter((f) => f.severity !== 'info').map((f) => `${f.code}: ${f.message}`) })) }, null, 2), 'utf8');
    out.push({
      ref,
      title,
      fileHash: deck.fileHash,
      slideCount: deck.slides.length,
      source: file,
      markdownPath,
      reportPath,
      confidence: `${{ high: '높음', medium: '보통', low: '낮음' }[deck.report.confidenceLabel]} (${Math.round(deck.report.overallConfidence * 100)}%)`,
      slidesNeedingAttention: deck.report.slidesRequiringAttention,
      caveats: deck.report.potentiallyMissing,
    });
  }
  writeFileSync(join(outDir, 'lectures.json'), JSON.stringify(out.map(({ ref, title, fileHash, slideCount, markdownPath }) => ({ ref, title, fileHash, slideCount, markdownPath })), null, 2), 'utf8');
  return out;
}

export function formatExtraction(results: ExtractedLecture[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.ref}  ${r.title}`, `    슬라이드 ${r.slideCount}장, 추출 신뢰도 ${r.confidence}`, `    Markdown: ${r.markdownPath}`);
    if (r.slidesNeedingAttention.length) lines.push(`    확인할 슬라이드 (내용이 누락되었을 수 있음): ${r.slidesNeedingAttention.join(', ')}`);
    for (const c of r.caveats) lines.push(`    - ${c}`);
  }
  return lines.join('\n');
}

export interface ValidationResult {
  ok: boolean;
  fatal?: string;
  plan?: PackPlan;
  report: string;
}

/**
 * Validate a study pack against the real lectures: every item, every cited slide, every quote.
 * `ok` is true only when nothing was skipped and no quote failed verification.
 */
export async function validatePackFile(packPath: string, lectureFiles: string[]): Promise<ValidationResult> {
  let raw: unknown;
  try {
    raw = extractJson(readFileSync(packPath, 'utf8'));
  } catch (err) {
    return { ok: false, fatal: err instanceof Error ? err.message : '읽을 수 없는 파일', report: `실패: ${err instanceof Error ? err.message : '학습 팩을 읽을 수 없습니다.'}` };
  }
  const decks: { title: string; deck: ParsedDeck }[] = [];
  for (const f of lectureFiles) {
    const { deck, title } = await load(f);
    decks.push({ title, deck });
  }
  const contexts: LectureContext[] = decks.map(({ title, deck }, i) => ({
    id: `lec${i + 1}`,
    title,
    fileHash: deck.fileHash,
    revision: 1,
    slideCount: deck.slides.length,
    slideText: (n) => {
      const s = deck.slides[n - 1];
      return s ? slideVerificationText(s) : undefined;
    },
  }));
  const plan = planPack(raw, 'course', contexts);
  if (plan.fatal) return { ok: false, fatal: plan.fatal, plan, report: `실패: ${plan.fatal}` };

  const lines: string[] = [];
  const s = plan.stats;
  lines.push(`항목: 전체 ${s.received}개, 가져오기 ${s.accepted}개, 건너뜀 ${s.rejected}개.`, `출처: 인용문 ${s.sources}개 중 ${s.verified}개를 실제 슬라이드에서 확인했고, ${s.unverified}개는 확인하지 못했습니다.`);
  for (const l of plan.lectureMap) lines.push(`강의 ${l.ref} "${l.title}" → ${l.localId ? `${contexts.find((c) => c.id === l.localId)?.title} (${{ hash: '파일 해시', title: '제목', manual: '직접 선택' }[l.how ?? 'manual']}로 연결)` : '일치하는 강의 파일 없음'}`);
  const problems = plan.issues.filter((i) => i.severity === 'error' || i.code !== undefined);
  if (problems.length) {
    lines.push('', '가져오기 전에 다음 문제를 수정하세요:');
    for (const i of problems) {
      lines.push(`  [${i.severity === 'error' ? '오류' : '주의'}] ${i.where}: ${i.message}`);
      if (i.slide) {
        const ctx = contexts.find((c) => c.title === i.slide?.lectureTitle);
        const t = ctx?.slideText(i.slide.number);
        if (t) lines.push(`      ${i.slide.number}번 슬라이드 원문: ${t.replace(/\s+/g, ' ').slice(0, 280)}`);
      }
    }
  }
  const ok = s.rejected === 0 && s.unverified === 0 && plan.issues.every((i) => i.severity !== 'error') && plan.lectureMap.every((l) => !!l.localId) && s.received > 0;
  lines.push('', ok ? '확인 완료: 학습 팩 형식과 모든 인용문이 확인되었습니다.' : '수정 필요: 위의 문제를 해결한 뒤 다시 검사하세요.');
  return { ok, plan, report: lines.join('\n') };
}

export function promptText(o: PromptOptions): string {
  return studyPackPrompt(o);
}

export const defaultPromptOptions: PromptOptions = { amount: 'normal', wants: { notes: true, cards: true, questions: true } };

export { extname };
