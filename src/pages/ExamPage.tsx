import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Flag, Lightbulb, Send } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { saveAnswer, setElapsed, submitAttempt, toggleFlag } from '@/core/study/attempts';
import { hasAnswer } from '@/core/study/exam';
import type { AnswerState, QuestionRow } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { AnswerInput, QuestionPrompt, Solution } from '@/ui/study/exam-ui';
import { Button, Callout, Dialog, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function ExamPage() {
  const { attemptId } = useParams();
  const attempt = useLiveQuery(async () => (attemptId ? ((await db.attempts.get(attemptId)) ?? null) : null), [attemptId]);
  const exam = useLiveQuery(async () => (attempt ? ((await db.exams.get(attempt.examId)) ?? null) : undefined), [attempt?.examId]);
  const questionsRaw = useLiveQuery(async () => (exam ? await db.questions.bulkGet(exam.questionIds) : undefined), [exam?.id]);
  const course = useLiveQuery(async () => (exam ? await db.courses.get(exam.courseId) : undefined), [exam?.courseId]);
  const toast = useToast();
  const navigate = useNavigate();

  const questions = useMemo(() => (questionsRaw ?? []).filter((q): q is QuestionRow => !!q), [questionsRaw]);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [loadedFor, setLoadedFor] = useState<string | undefined>();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [hintShown, setHintShown] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<Record<string, Partial<AnswerState>>>({});
  const timer = useRef<number | undefined>(undefined);
  const base = useRef({ elapsed: 0, at: 0 });
  const submitted = useRef(false);

  // Load saved answers once (resume after reload).
  if (attempt && loadedFor !== attempt.id) {
    setLoadedFor(attempt.id);
    setAnswers(attempt.answers);
    base.current = { elapsed: attempt.elapsedMs, at: Date.now() };
  }

  const cfg = exam?.config;
  const conditions = !!cfg?.conditions;
  const elapsed = !attempt ? 0 : conditions ? now - attempt.startedAt : base.current.elapsed + (now - base.current.at);
  const limit = cfg?.minutes ? cfg.minutes * 60_000 : undefined;
  const remaining = limit !== undefined ? limit - elapsed : undefined;

  const flush = useCallback(async () => {
    const p = pending.current;
    pending.current = {};
    if (!attemptId) return;
    try {
      for (const [qid, patch] of Object.entries(p)) await saveAnswer(db, attemptId, qid, patch);
    } catch {
      /* the attempt may have been submitted in the meantime; nothing to save */
    }
  }, [attemptId]);

  const change = useCallback(
    (qid: string, patch: Partial<AnswerState>) => {
      setAnswers((a) => ({ ...a, [qid]: { timeMs: 0, ...a[qid], ...patch } }));
      pending.current[qid] = { ...pending.current[qid], ...patch };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 400);
    },
    [flush],
  );

  const doSubmit = useCallback(
    async (auto = false) => {
      if (!attempt || submitted.current) return;
      submitted.current = true;
      setSubmitting(true);
      try {
        window.clearTimeout(timer.current);
        await flush();
        await submitAttempt(db, attempt.id, questions, conditions ? Date.now() - attempt.startedAt : base.current.elapsed + (Date.now() - base.current.at));
        if (auto) toast.show('시간이 다 되어 시험을 제출했습니다.', 'info');
        navigate(`/exam/${attempt.id}/results`, { replace: true });
      } catch (err) {
        submitted.current = false;
        setSubmitting(false);
        toast.show(err instanceof Error ? err.message : '제출하지 못했습니다.', 'error');
      }
    },
    [attempt, questions, conditions, flush, navigate, toast],
  );

  // Clock, elapsed-time persistence, and automatic submission when time runs out.
  useEffect(() => {
    if (!attempt || attempt.status === 'submitted') return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const persist = window.setInterval(() => {
      if (!conditions) void setElapsed(db, attempt.id, base.current.elapsed + (Date.now() - base.current.at)).catch(() => undefined);
    }, 5000);
    const leave = () => {
      void flush();
      if (!conditions) void setElapsed(db, attempt.id, base.current.elapsed + (Date.now() - base.current.at)).catch(() => undefined);
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(persist);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [attempt?.id, attempt?.status, conditions, flush]);

  useEffect(() => {
    if (remaining !== undefined && remaining <= 0 && attempt?.status === 'in-progress' && questions.length > 0) void doSubmit(true);
  }, [remaining, attempt?.status, questions.length, doSubmit]);

  // Arrow keys move between questions (not while typing).
  useEffect(() => {
    if (cfg?.layout !== 'one') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(questions.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cfg?.layout, questions.length]);

  if (attempt === null || exam === null) return <NotFound what="시험이" />;
  if (!attempt || !exam || !cfg || !questionsRaw || !course) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  if (attempt.status === 'submitted') return <Navigate to={`/exam/${attempt.id}/results`} replace />;
  if (questions.length === 0) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <Callout tone="bad" title="이 시험의 문제를 더 이상 쓸 수 없습니다">
          문제 은행에서 삭제되었습니다. <Link className="underline" to={`/course/${course.id}/practice`}>연습으로 돌아가기</Link>
        </Callout>
      </div>
    );
  }

  const answeredCount = questions.filter((q) => hasAnswer(answers[q.id])).length;
  const flagged = new Set(attempt.flagged);
  const canHint = cfg.hints && !conditions;
  const immediate = cfg.reveal === 'immediate' && !conditions;

  const questionCard = (q: QuestionRow, i: number) => {
    const a = answers[q.id];
    const showSolution = immediate && revealed.has(q.id);
    return (
      <article key={q.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-5 md:p-6" aria-labelledby={`qh-${q.id}`}>
        <h2 id={`qh-${q.id}`} className="sr-only">
          문제 {i + 1}/{questions.length}
        </h2>
        <QuestionPrompt q={q} index={i + 1} />
        <AnswerInput q={q} answer={a} onChange={(p) => change(q.id, p)} id={`ans-${q.id}`} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={flagged.has(q.id) ? 'secondary' : 'ghost'} aria-pressed={flagged.has(q.id)} onClick={() => void toggleFlag(db, attempt.id, q.id)}>
            <Flag className="size-4" aria-hidden /> {flagged.has(q.id) ? '다시 볼 문제로 표시됨' : '다시 볼 문제로 표시'}
          </Button>
          {canHint && q.hint && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setHintShown(new Set(hintShown).add(q.id));
                change(q.id, { hintUsed: true });
              }}
            >
              <Lightbulb className="size-4" aria-hidden /> 힌트 보기
            </Button>
          )}
          {immediate && !showSolution && (
            <Button size="sm" onClick={() => setRevealed(new Set(revealed).add(q.id))} disabled={!hasAnswer(a)}>
              내 답 확인
            </Button>
          )}
        </div>
        {canHint && q.hint && hintShown.has(q.id) && <p className="mt-3 rounded bg-warn-soft px-3 py-2 text-sm text-ink">힌트: {q.hint}</p>}
        {showSolution && (
          <div className="mt-4 border-t border-rule pt-4">
            <Solution q={q} chosen={a?.optionIds} />
            <p className="mt-3 text-[13px] text-ink-3">서술형 답은 시험을 제출할 때 채점합니다.</p>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 md:px-6 md:py-6">
      <header className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <div className="min-w-0">
          <p className="truncate text-[13px] text-ink-3">{course.name}</p>
          <h1 className="truncate text-lg font-semibold tracking-tight">{cfg.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm tabular-nums text-ink-2" aria-live="off">
            {questions.length}문제 중 {answeredCount}문제 답함
          </p>
          <p className={`rounded-full px-3 py-1 text-sm font-medium tabular-nums ${remaining !== undefined && remaining < 300_000 ? 'bg-bad-soft text-bad' : 'bg-sunken text-ink'}`} role="timer" aria-label={remaining !== undefined ? `남은 시간 ${clock(remaining)}` : `걸린 시간 ${clock(elapsed)}`}>
            {remaining !== undefined ? `${clock(remaining)} 남음` : clock(elapsed)}
          </p>
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={submitting}>
            <Send className="size-4" aria-hidden /> 제출
          </Button>
        </div>
      </header>
      <p className="sr-only" aria-live="polite">
        {remaining !== undefined && remaining <= 60_000 && remaining > 55_000 ? '1분 남았습니다.' : remaining !== undefined && remaining <= 300_000 && remaining > 295_000 ? '5분 남았습니다.' : ''}
      </p>

      {conditions && (
        <p className="mt-4 rounded bg-sunken px-3 py-2 text-sm text-ink-2">
          시험 조건: 힌트를 쓸 수 없고, 제출하기 전에는 답을 볼 수 없으며, 이 페이지를 떠나도 시간은 계속 흐릅니다.
        </p>
      )}

      {cfg.layout === 'one' ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_11rem]">
          <main aria-label="문제">
            {questionCard(questions[index]!, index)}
            <div className="mt-4 flex items-center justify-between">
              <Button onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0}>
                <ChevronLeft className="size-4" aria-hidden /> 이전
              </Button>
              <Button onClick={() => setIndex(Math.min(questions.length - 1, index + 1))} disabled={index === questions.length - 1}>
                다음 <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </main>
          <nav aria-label="문제 이동" className="lg:sticky lg:top-24 lg:self-start">
            <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-10 lg:grid-cols-4">
              {questions.map((q, i) => (
                <li key={q.id}>
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? 'step' : undefined}
                    aria-label={`문제 ${i + 1}${hasAnswer(answers[q.id]) ? ', 답함' : ', 답 안 함'}${flagged.has(q.id) ? ', 표시함' : ''}`}
                    className={`relative flex size-10 items-center justify-center rounded-[var(--radius-control)] border text-sm tabular-nums ${i === index ? 'border-accent bg-accent text-accent-ink' : hasAnswer(answers[q.id]) ? 'border-accent/50 bg-accent-soft text-ink' : 'border-rule-strong bg-surface text-ink-2 hover:bg-sunken'}`}
                  >
                    {i + 1}
                    {flagged.has(q.id) && <Flag className="absolute -right-1 -top-1 size-3.5 fill-warn text-warn" aria-hidden />}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      ) : (
        <main className="mt-5 flex flex-col gap-5" aria-label="시험지">
          {questions.map((q, i) => questionCard(q, i))}
        </main>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="시험을 제출할까요?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              계속 풀기
            </Button>
            <Button variant="primary" disabled={submitting} onClick={() => void doSubmit(false)}>
              지금 제출
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {questions.length}문제 중 {answeredCount}문제에 답했습니다.
          </p>
          {questions.length - answeredCount > 0 && <p className="text-warn">답하지 않은 {questions.length - answeredCount}문제는 0점이 됩니다.</p>}
          {flagged.size > 0 && <p className="text-ink-2">다시 볼 문제로 {flagged.size}개를 표시했습니다.</p>}
          <p className="text-ink-2">제출하면 답을 바꿀 수 없습니다. 객관식과 참/거짓 문제는 바로 채점되고, 서술형 답은 모범 답안과 비교해 직접 채점합니다.</p>
        </div>
      </Dialog>
    </div>
  );
}
