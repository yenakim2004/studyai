import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useSetting } from '@/app/data';
import { getDb } from '@/core/db/db';
import { displayTitle } from '@/core/pptx/topics';
import type { Grade, QuestionRow } from '@/core/study/types';
import { buildContext, slideContextText, type ContextSlide } from '@/core/tutor/context';
import { readGradeReply, type GradeProposal } from '@/core/tutor/parse';
import { MathText } from '@/ui/MathText';
import { Button } from '@/ui/primitives';
import { aiBlocker } from '@/ui/ai/blocker';
import { AI_DESTINATION as dest } from '@/ui/ai/destination';

const db = getDb();

const OVERALL = (marks: number) => [{ id: 'overall', text: '모범 답안과 비교해 답이 완전하고 정확하다.', marks }];

/**
 * An optional second opinion on a written answer. It is an ESTIMATE against the marking points, labelled as the AI's, never
 * an examiner's mark, and it only becomes your mark when you accept it. What is sent is shown first.
 */
export function AiGradeAssist({ q, answerText, onAccept }: { q: QuestionRow; answerText: string; onAccept: (g: Grade) => Promise<void> }) {
  const ai = useAiServer();
  const [consent, setConsent] = useSetting<string>(dest.consentKey);
  useEffect(() => {
    void refreshAi(); // after a page reload the state starts empty; asking is cheap and shared between screens
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposal, setProposal] = useState<GradeProposal | undefined>();
  const blocker = aiBlocker(ai);
  const usable = blocker === undefined;
  const rubric = q.rubric.length > 0 ? q.rubric.map((p) => ({ id: p.id, text: p.text, marks: p.marks })) : OVERALL(q.marks);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setProposal(undefined);
    try {
      // Up to three of the slides the question came from help the grader stay faithful to the lecture.
      const ctx: ContextSlide[] = [];
      for (const s of q.sources.slice(0, 3)) {
        const lec = await db.lectures.get(s.lectureId);
        const row = await db.slides.get([s.lectureId, s.slide]);
        if (lec && row) ctx.push({ lectureId: lec.id, lectureTitle: lec.title, revision: lec.revision, slide: s.slide, title: displayTitle(row), text: slideContextText(row, lec.meta.slideHeight) });
      }
      const excerpts = buildContext(ctx).excerpts;
      const reply = await askAi({
        task: 'grade',
        question: { type: q.type, prompt: q.prompt.slice(0, 10_000), marks: q.marks, ...(q.modelAnswer?.trim() ? { modelAnswer: q.modelAnswer.slice(0, 10_000) } : {}), rubric: rubric.map((r) => ({ ...r, id: r.id.slice(0, 80), text: r.text.slice(0, 2_000) })) },
        answer: answerText.slice(0, 20_000),
        ...(excerpts.length > 0 ? { excerpts: excerpts.slice(0, 6) } : {}),
      });
      if (!reply.ok) setError(reply.message);
      else {
        const read = readGradeReply(reply, rubric);
        if (read.ok) setProposal(read.proposal);
        else setError(read.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '채점 도우미의 답을 읽지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const accept = async (p: GradeProposal) => {
    const items = q.rubric.length > 0 ? p.points.map((x) => ({ pointId: x.id, awarded: x.awarded })) : [];
    const comment = [p.feedback, p.missing.length > 0 ? `빠진 내용: ${p.missing.join('; ')}` : ''].filter(Boolean).join(' ').slice(0, 5_000);
    await onAccept({ marks: Math.min(q.marks, p.total), max: q.marks, items, ...(comment ? { comment } : {}), by: 'ai', uncertain: true, gradedAt: Date.now() });
    setProposal(undefined);
  };

  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-sunken/40 p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4" aria-hidden /> AI의 두 번째 의견(선택)
      </h4>
      <p className="mt-1 max-w-prose text-[13px] text-ink-3">AI가 채점 기준에 비추어 내 답을 읽고 점수를 제안합니다. 채점자의 점수가 아닌 추정치이며 틀릴 수 있습니다. 요청 한 번으로 내 답, 문제, 채점 기준, 출처 슬라이드 최대 3장을 {dest.sentTo}에 보냅니다.</p>

      {!usable ? (
        <p className="mt-2 text-sm text-ink-2">
          {blocker}{' '}
          {ai.phase === 'ready' && <Link to="/settings" className="text-accent underline underline-offset-2">설정 → AI 열기</Link>}
        </p>
      ) : (
        <div className="mt-3">
          {!consent && (
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" onChange={(e) => e.target.checked && void setConsent(new Date().toISOString().slice(0, 10))} />
              <span>{dest.consent}</span>
            </label>
          )}
          <Button size="sm" disabled={busy || !consent || answerText.trim().length === 0} onClick={() => void run()}>
            {busy ? '묻는 중…' : 'AI에게 채점 요청'}
          </Button>
          {answerText.trim().length === 0 && <span className="ml-3 text-sm text-ink-3">채점할 답이 없습니다.</span>}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}

      {proposal && (
        <div className="mt-4 border-t border-rule pt-4" aria-label="AI가 제안한 점수">
          <p className="text-sm">
              제안: <span className="font-semibold tabular-nums">{proposal.total}</span> / {q.marks}{' '}
              <span className="text-ink-3">· AI의 확신도: {{ low: '낮음', medium: '보통', high: '높음' }[proposal.confidence]}. 대략적인 추정치로 보세요.</span>
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {proposal.points.map((p) => {
              const r = rubric.find((x) => x.id === p.id);
              return (
                <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-rule pt-1 first:border-t-0">
                  <span>
                    {r ? <MathText>{r.text}</MathText> : null}
                    {p.reason && <span className="block text-ink-3">{p.reason}</span>}
                  </span>
                  <span className="tabular-nums">
                    {p.awarded} / {p.max}
                  </span>
                </li>
              );
            })}
          </ul>
          {proposal.feedback && <p className="mt-2 text-sm">{proposal.feedback}</p>}
          {proposal.missing.length > 0 && <p className="mt-1 text-sm text-ink-2">빠졌을 수 있는 내용: {proposal.missing.join('; ')}.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => void accept(proposal)}>
              이 점수 쓰기
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(undefined)}>
              버리기
            </Button>
          </div>
          <p className="mt-2 text-[13px] text-ink-3">이 점수를 쓰면 “AI 추정”으로 저장됩니다. 아래에서 계속 고칠 수 있습니다.</p>
        </div>
      )}
    </div>
  );
}
