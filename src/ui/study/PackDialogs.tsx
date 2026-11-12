import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ClipboardCopy, Download } from 'lucide-react';
import { getDb, type CourseRow, type LectureRow } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import type { PlannedSlot } from '@/core/study/blueprint';
import { lectureToMarkdown, studyPackPrompt, type PromptOptions } from '@/core/study/markdown';
import type { AuditQuestion } from '@/core/study/audit';
import { extractJson, planPack, recoverTruncatedJson, type LectureContext, type PackPlan } from '@/core/study/pack';
import { removeMarkingPoint } from '@/core/study/pack-edit';
import type { QualityStats } from '@/core/study/pack-quality';
import { QUESTION_TYPE_LABEL, type QuestionType } from '@/core/study/types';
import { slideVerificationText } from '@/core/study/slide-text';
import { applyPackPlan } from '@/core/study/store';
import { useQuestions } from '@/app/data';
import { useToast } from '@/app/toast';
import { AuditPanel } from '@/ui/ai/AuditPanel';
import { Button, Callout, Dialog, Field, Select, Spinner, TextArea } from '@/ui/primitives';

const db = getDb();

// ---------------------------------------------------------------------------
// Export: lecture text + prompt for the AI you already pay for
// ---------------------------------------------------------------------------

export function AiExportDialog({ open, onClose, course, lectures }: { open: boolean; onClose: () => void; course: CourseRow; lectures: LectureRow[] }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [wants, setWants] = useState({ notes: true, cards: true, questions: true });
  const [amount, setAmount] = useState<PromptOptions['amount']>('normal');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPicked(new Set(lectures.map((l) => l.id)));
      setText('');
    }
  }, [open, lectures]);

  const chosen = lectures.filter((l) => picked.has(l.id));
  const slideTotal = chosen.reduce((n, l) => n + l.slideCount, 0);

  const build = async (): Promise<string> => {
    setBusy(true);
    try {
      const parts: string[] = [];
      let i = 1;
      for (const l of chosen) parts.push(lectureToMarkdown(l, await loadSlides(db, l.id), `L${i++}`));
      const prompt = studyPackPrompt({ examStyle: course.examStyle, wants, amount });
      const out = `${prompt}\n\n=====  LECTURES  =====\n\n${parts.join('\n\n=====\n\n')}\n`;
      setText(out);
      return out;
    } finally {
      setBusy(false);
    }
  };

  const approxTokens = text ? Math.round(text.length / 4) : Math.round(slideTotal * 450);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="다른 AI로 학습 팩 만들기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            닫기
          </Button>
          <Button
            disabled={chosen.length === 0 || busy || (!wants.notes && !wants.cards && !wants.questions)}
            onClick={async () => {
              const out = text || (await build());
              const url = URL.createObjectURL(new Blob([out], { type: 'text/markdown' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `${course.name.replace(/[^\w-]+/g, '-')}-lectures-for-ai.md`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }}
          >
            <Download className="size-4" aria-hidden /> .md 파일 내려받기
          </Button>
          <Button
            variant="primary"
            disabled={chosen.length === 0 || busy || (!wants.notes && !wants.cards && !wants.questions)}
            onClick={async () => {
              const out = text || (await build());
              try {
                await navigator.clipboard.writeText(out);
                toast.show('복사했습니다. AI 채팅에 붙여 넣은 뒤 돌려받은 JSON을 가져오세요.', 'ok');
              } catch {
                toast.show('브라우저가 복사를 막았습니다. 대신 “.md 파일 내려받기”를 쓰세요.', 'error');
              }
            }}
          >
            <ClipboardCopy className="size-4" aria-hidden /> {busy ? '준비 중' : '프롬프트와 강의 복사'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-ink-2">
          이 기능은 AI를 <span className="font-medium text-ink">호출하지 않습니다</span>. 지시문과 강의에서 추출한 텍스트(슬라이드 번호 포함)를 한 덩어리로 준비합니다. 이미 쓰는 AI에 붙여 넣은 뒤, AI가 쓴 JSON을 “학습 팩 가져오기”로 가져오세요. 인용한 문장은 모두 실제 슬라이드와 대조합니다.
        </p>
        <Callout tone="warn" title="붙여 넣기 전에">
          강의 텍스트는 붙여 넣는 AI 서비스로 전달됩니다. 일부 서비스의 무료 요금제는 내용을 제품 개선에 쓸 수 있으니 먼저 그 서비스의 약관을 확인하세요. 이 앱에서는 아무것도 보내지 않습니다.
        </Callout>
        <fieldset>
          <legend className="mb-1 font-medium">포함할 강의</legend>
          <ul className="max-h-44 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
            {lectures.map((l) => (
              <li key={l.id}>
                <label className="flex min-h-10 cursor-pointer items-center gap-2.5 px-3 hover:bg-sunken">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={picked.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(l.id);
                      else next.delete(l.id);
                      setPicked(next);
                      setText('');
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{l.title}</span>
                  <span className="text-ink-3">슬라이드 {l.slideCount}장</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 font-medium">요청할 것</legend>
            {(['notes', 'cards', 'questions'] as const).map((k) => (
              <label key={k} className="flex min-h-9 items-center gap-2.5">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={wants[k]} onChange={(e) => { setWants({ ...wants, [k]: e.target.checked }); setText(''); }} />
                {{ notes: '노트와 요약', cards: '플래시카드', questions: '채점 기준이 있는 연습 문제' }[k]}
              </label>
            ))}
          </fieldset>
          <Field label="양" htmlFor="amount">
            <Select id="amount" value={amount} onChange={(e) => { setAmount(e.target.value as PromptOptions['amount']); setText(''); }}>
              <option value="few">종류마다 조금(빠르게)</option>
              <option value="normal">보통</option>
              <option value="many">쓸모 있는 만큼 많이</option>
            </Select>
          </Field>
        </div>
        {course.examStyle?.trim() ? (
          <p className="text-ink-2">
            저장한 출제 안내가 포함됩니다: <span className="italic">“{course.examStyle.trim().slice(0, 140)}{course.examStyle.trim().length > 140 ? '…' : ''}”</span>
          </p>
        ) : (
          <p className="text-ink-3">팁: 과목 정보에 교수의 출제 스타일을 추가하면 여기에 포함됩니다.</p>
        )}
        <p className="text-ink-3">
          텍스트는 약 {approxTokens.toLocaleString('ko-KR')}토큰입니다{approxTokens > 100_000 ? '. 꽤 많습니다. AI가 슬라이드에 충실하도록 한 번에 고르는 강의를 줄이세요.' : '.'}
        </p>
      </div>
    </Dialog>
  );
}

/** The shape of a set of generated exam questions: kinds, difficulty, marks, and whether it came back as planned. */
function QuestionSetSummary({ stats }: { stats: QualityStats }) {
  const kinds = (Object.entries(stats.byType) as [QuestionType, number][]).map(([t, n]) => `${QUESTION_TYPE_LABEL[t]} ${n}개`).join(', ');
  return (
    <section aria-label="이 팩의 시험 문제" className="rounded-[var(--radius-control)] border border-rule px-3 py-2 text-ink-2">
      <h3 className="font-medium text-ink">
        시험 문제 {stats.questions}개 · 총 {stats.totalMarks}점
      </h3>
      <p>
        유형: {kinds}. 난이도: 쉬움 {stats.byDifficulty[1]}, 보통 {stats.byDifficulty[2]}, 어려움 {stats.byDifficulty[3]}.
        {stats.asPlanned ? ` 계획한 ${stats.asPlanned.of}개 중 ${stats.asPlanned.met}개가 계획대로 돌아왔습니다.` : ''} 인용한 슬라이드는 {stats.slidesCited.length}장입니다.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Import: validate a pack, show exactly what will happen, then store it for review
// ---------------------------------------------------------------------------

export function PackImportDialog({ open, onClose, course, lectures, initialText, cutOff, expected }: { open: boolean; onClose: () => void; course: CourseRow; lectures: LectureRow[]; initialText?: string; cutOff?: boolean; expected?: PlannedSlot[] }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [raw, setRaw] = useState<unknown>();
  const [error, setError] = useState<string | undefined>();
  /** How many complete items were rescued from an answer that was cut off (undefined when the pack read normally). */
  const [rescued, setRescued] = useState<number | undefined>();
  const [contexts, setContexts] = useState<LectureContext[] | undefined>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText('');
    setRaw(undefined);
    setError(undefined);
    setRescued(undefined);
    setMapping({});
    let cancelled = false;
    void (async () => {
      const out: LectureContext[] = [];
      for (const l of lectures) {
        const slides = await loadSlides(db, l.id);
        out.push({
          id: l.id,
          title: l.title,
          fileHash: l.fileHash,
          revision: l.revision,
          slideCount: l.slideCount,
          slideText: (i) => {
            const s = slides[i - 1];
            return s ? slideVerificationText(s) : undefined;
          },
        });
      }
      if (!cancelled) setContexts(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, lectures]);

  // The questions the course already has: a question that repeats one of them is pointed out.
  const haveQuestions = useQuestions(course.id);
  const existingPrompts = useMemo(() => (haveQuestions ?? []).map((q) => q.prompt), [haveQuestions]);
  const plan: PackPlan | undefined = useMemo(
    () => (raw !== undefined && contexts ? planPack(raw, course.id, contexts, mapping, Date.now(), { ...(expected ? { expected } : {}), existingPrompts }) : undefined),
    [raw, contexts, course.id, mapping, expected, existingPrompts],
  );

  const check = (source: string) => {
    setError(undefined);
    setRescued(undefined);
    try {
      setRaw(extractJson(source));
      setMapping({});
    } catch (err) {
      // An answer that hit its length limit stops in the middle of the JSON: keep the items that were finished.
      const kept = recoverTruncatedJson(source);
      if (kept) {
        setRaw(kept.value);
        setRescued(kept.items);
        setMapping({});
        return;
      }
      setRaw(undefined);
      setError(cutOff ? 'AI가 항목을 하나도 끝내기 전에 답 길이 한도에 닿아 남길 수 있는 것이 없습니다. 항목이나 슬라이드를 줄여서 요청하세요.' : err instanceof Error ? err.message : '팩을 읽지 못했습니다.');
    }
  };

  // A pack written by the AI tutor arrives already pasted, so the checking screen opens straight away.
  useEffect(() => {
    if (open && initialText) {
      setText(initialText);
      check(initialText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check only sets state
  }, [open, initialText]);

  /** The written questions as the AI check reads them; `n` is the place the AI wrote each at, so a finding finds its way back to the pack. */
  const auditQs: AuditQuestion[] = useMemo(
    () => (plan?.questions ?? []).map((q, i) => ({ n: (plan?.questionAt[i] ?? i) + 1, type: q.type, prompt: q.prompt, marks: q.marks, rubric: q.rubric.map((r) => ({ text: r.text, marks: r.marks })), ...(q.modelAnswer ? { modelAnswer: q.modelAnswer } : {}) })),
    [plan],
  );
  /** Takes a marking point out of the pack (and its marks off the question); the whole pack is checked again. */
  const removePoint = (question: number, point: number) => setRaw((r: unknown) => removeMarkingPoint(r, question, point));

  const count = plan ? plan.cards.length + plan.notes.length + plan.questions.length : 0;
  const warnings = plan?.issues.filter((i) => i.severity === 'warning') ?? [];
  const errors = plan?.issues.filter((i) => i.severity === 'error') ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="학습 팩 가져오기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!plan || !!plan.fatal || count === 0 || busy}
            onClick={async () => {
              if (!plan) return;
              setBusy(true);
              try {
                const r = await applyPackPlan(db, course.id, plan);
                toast.show(`검토할 카드 ${r.cards}장, 노트 ${r.notes}개, 문제 ${r.questions}개를 가져왔습니다.`, 'ok');
                onClose();
                navigate(`/course/${course.id}/cards?status=pending`);
              } catch (err) {
                toast.show(err instanceof Error ? err.message : '가져오지 못했습니다.', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {count > 0 ? `검토할 항목 ${count}개 가져오기` : '가져오기'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-ink-2">
          AI가 만든 JSON을 붙여 넣거나 파일을 고르세요. 가져오기를 누르기 전에는 아무것도 저장되지 않으며, 가져온 항목은 승인하기 전까지 학습에 쓰이지 않습니다.
        </p>
        <Field label="팩 JSON" htmlFor="pack-text">
          <TextArea id="pack-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{ "format": "studyai-pack", … }'} className="font-mono text-[13px]" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={!text.trim() || !contexts} onClick={() => check(text)}>
            이 팩 확인
          </Button>
          <label className="inline-flex min-h-10 cursor-pointer items-center rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3.5 text-sm font-medium hover:bg-sunken">
            파일 고르기
            <input
              type="file"
              accept=".json,.txt,application/json,text/plain"
              className="sr-only"
              aria-label="팩 파일 고르기"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 20 * 1024 * 1024) {
                  setError('파일이 20MB보다 큽니다. 학습 팩에 필요한 크기보다 훨씬 큽니다.');
                  return;
                }
                const t = await f.text();
                setText(t);
                check(t);
              }}
            />
          </label>
          {!contexts && <Spinner label="강의를 읽는 중" />}
        </div>

        {error && <Callout tone="bad" title="읽을 수 없습니다">{error}</Callout>}
        {rescued !== undefined && (
          <Callout tone="warn" title="AI의 답이 중간에 잘렸습니다">
            답 길이 한도에 닿아 끝까지 쓰지 못했으므로, 잘리기 전에 끝난 항목 {rescued}개만 여기에 보입니다. 그 뒤의 내용은 없습니다. 이 항목을 지금 가져오고 다른 슬라이드로 더 요청할 수 있습니다.
          </Callout>
        )}
        {plan?.fatal && <Callout tone="bad" title="쓸 수 없는 팩">{plan.fatal}</Callout>}

        {plan && !plan.fatal && (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-4">
              {(
                [
                  ['플래시카드', plan.cards.length],
                  ['노트', plan.notes.length],
                  ['문제', plan.questions.length],
                  ['건너뜀', plan.stats.rejected],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-surface px-3 py-2">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className={`text-lg font-semibold tabular-nums ${k === '건너뜀' && v > 0 ? 'text-bad' : ''}`}>{v}</dd>
                </div>
              ))}
            </dl>
            {plan.quality && <QuestionSetSummary stats={plan.quality.stats} />}
            {plan.questions.length > 0 && <AuditPanel questions={auditQs} onRemove={(n, point) => removePoint(n - 1, point)} />}
            <p className="text-ink-2">
              출처: 인용문 {plan.stats.sources}개 중 {plan.stats.verified}개를 슬라이드에서 찾았습니다{plan.stats.unverified > 0 ? `(${plan.stats.unverified}개는 찾지 못함)` : ''}. 확인된 인용문이 없는 항목은 확인할 수 있도록 표시됩니다.
            </p>

            {plan.lectureMap.length > 0 && (
              <div>
                <h3 className="mb-1 font-medium">강의 연결</h3>
                <ul className="divide-y divide-rule rounded-[var(--radius-control)] border border-rule">
                  {plan.lectureMap.map((l) => (
                    <li key={l.ref} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <span className="min-w-0 truncate">
                        <span className="font-mono text-[13px] text-ink-3">{l.ref}</span> {l.title}
                      </span>
                      <span className="flex items-center gap-2">
                        <label className="sr-only" htmlFor={`map-${l.ref}`}>
                          {l.title}에 연결할 내 강의
                        </label>
                        <Select id={`map-${l.ref}`} value={l.localId ?? ''} onChange={(e) => setMapping({ ...mapping, [l.ref]: e.target.value })} className="min-h-9 text-[13px]">
                          <option value="">연결 안 함</option>
                          {lectures.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.title}
                            </option>
                          ))}
                        </Select>
                        {l.how && <span className="shrink-0 text-xs text-ink-3">{l.how === 'hash' ? '같은 파일' : l.how === 'title' ? '같은 제목' : '직접 고름'}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(errors.length > 0 || warnings.length > 0) && (
              <details className="rounded-[var(--radius-control)] border border-rule p-3" open={errors.length > 0}>
                <summary className="flex cursor-pointer items-center gap-2 font-medium">
                  <AlertTriangle className="size-4 text-warn" aria-hidden /> 건너뛴 항목 {errors.length}개, 경고 {warnings.length}개
                </summary>
                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-[13px] text-ink-2">
                  {[...errors, ...warnings].slice(0, 80).map((i, k) => (
                    <li key={k} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{i.where}:</span> {i.message}
                      </span>
                      {i.fix && (
                        <Button size="sm" variant="secondary" onClick={() => removePoint(i.fix!.question, i.fix!.point)} aria-label={`${i.where}의 채점 기준 ${i.fix.point + 1} 삭제`}>
                          이 기준 삭제
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
