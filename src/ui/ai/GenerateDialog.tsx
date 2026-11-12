import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useQuestions, useSetting } from '@/app/data';
import { getDb } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import type { CourseRow, LectureRow } from '@/core/db/db';
import type { SlideData } from '@/core/pptx/model';
import { buildBlueprint, describeSlot, splitIntoRequests, type PlannedSlot } from '@/core/study/blueprint';
import { lectureToMarkdown } from '@/core/study/markdown';
import { packCounts } from '@/core/study/pack-format';
import { AI_OUTPUT_CAP, LIMITS } from '@/core/tutor/contract';
import { generateOutputTokens } from '@/core/tutor/prompts';
import { Button, Dialog, Select, TextInput } from '@/ui/primitives';
import { aiBlocker } from '@/ui/ai/blocker';
import { AI_DESTINATION as dest } from '@/ui/ai/destination';

const db = getDb();

const MAX_QUESTIONS = 30;

/**
 * Asks the AI to write a study pack (cards, notes, questions) from chosen lectures. The result is NOT used directly: it goes
 * to the normal "Import a study pack" check, where every quote is verified against the real slides and every item waits for
 * your approval.
 *
 * Exam questions are planned here first, on the device (blueprint.ts): the mix of kinds, the difficulty, the marks and the
 * slides of each question, from the topics of the lecture, the professor's exam instructions and the questions you already
 * have. The AI only fills in the plan, and what it sends back is checked against the plan.
 */
export function GenerateDialog({
  open,
  onClose,
  course,
  lectures,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  course: CourseRow;
  lectures: LectureRow[];
  onGenerated: (json: string, cutOff: boolean, expected?: PlannedSlot[]) => void;
}) {
  const ai = useAiServer();
  const [consent, setConsent] = useSetting<string>(dest.consentKey);
  const existing = useQuestions(course.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Only the slides in these ranges are sent (default: all). Title and acknowledgement slides need not leave the device.
  const [ranges, setRanges] = useState<Record<string, { from: string; to: string }>>({});
  const rangeOf = (l: LectureRow): { from: number; to: number; ok: boolean } => {
    const r = ranges[l.id];
    const from = r?.from === undefined || r.from === '' ? 1 : Number(r.from);
    const to = r?.to === undefined || r.to === '' ? l.slideCount : Number(r.to);
    return { from, to, ok: Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= l.slideCount && from <= to };
  };
  /** Topics the student switched off (`lectureId:topicId`): their slides are neither sent nor asked about. */
  const [topicOff, setTopicOff] = useState<Set<string>>(new Set());
  const [wants, setWants] = useState({ notes: false, cards: true, questions: true });
  const [amount, setAmount] = useState<'few' | 'normal' | 'many'>('few');
  const [questionCount, setQuestionCount] = useState('8');
  const [loaded, setLoaded] = useState<Record<string, SlideData[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    void refreshAi();
    setError(undefined);
    setPicked(new Set(lectures.slice(0, 1).map((l) => l.id)));
    setRanges({});
    setTopicOff(new Set());
  }, [open, lectures]);

  // A lecture's slides are cached under its id AND its last change, so picture words typed since the last time are never missed.
  const cacheKey = (l: LectureRow) => `${l.id}:${l.updatedAt}`;

  // The slides of the chosen lectures, read from this device.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, SlideData[]> = {};
      for (const l of lectures.filter((x) => picked.has(x.id))) if (!loaded[cacheKey(l)]) next[cacheKey(l)] = await loadSlides(db, l.id);
      if (!cancelled && Object.keys(next).length > 0) setLoaded((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loaded` is keyed by lecture version and only grows; it is read to skip what is already read
  }, [open, picked, lectures]);

  // Exam questions are planned for one lecture at a time (slide numbers belong to a lecture), so with questions wanted only the
  // first chosen lecture is used.
  const chosen = lectures.filter((l) => picked.has(l.id));
  const sending = wants.questions ? chosen.slice(0, 1) : chosen;
  const planLecture = wants.questions ? sending[0] : undefined;
  /** False until every lecture that would be sent has been read: nothing is offered for sending before then. */
  const ready = sending.length > 0 && sending.every((l) => !!loaded[cacheKey(l)]);

  /** The slides of a lecture that are sent: inside the range and not in a switched-off topic. */
  const slidesToSend = (l: LectureRow): SlideData[] => {
    const r = rangeOf(l);
    const off = l.report.topics.filter((t) => topicOff.has(`${l.id}:${t.id}`));
    return (loaded[cacheKey(l)] ?? []).filter((s) => r.ok && s.index >= r.from && s.index <= r.to && !off.some((t) => s.index >= t.startSlide && s.index <= t.endSlide));
  };
  const noSlides = ready && sending.some((l) => rangeOf(l).ok && slidesToSend(l).length === 0);

  // The exact text that would be sent. Slides keep their own numbers in the headings, so every answer can be checked against the right slide.
  const markdown = useMemo(
    () => (ready && !noSlides ? sending.map((l, i) => lectureToMarkdown(l, slidesToSend(l), `L${i + 1}`)).join('\n\n---\n\n') : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slidesToSend reads ranges, topicOff and loaded, all listed
    [ready, noSlides, sending.map(cacheKey).join(','), ranges, topicOff, loaded],
  );

  const blocker = aiBlocker(ai);
  const usable = blocker === undefined;
  const tooBig = markdown.length > LIMITS.lectureMarkdown;
  const none = !wants.notes && !wants.cards && !wants.questions;
  const badRange = lectures.some((l) => picked.has(l.id) && !rangeOf(l).ok);
  // One request can only hold so many items (the prompt asks for at most this many tokens), so the real numbers are shown.
  const outputCap = generateOutputTokens(AI_OUTPUT_CAP);

  // ---- the exam plan -------------------------------------------------------------------------
  const wanted = Number(questionCount);
  const countOk = Number.isInteger(wanted) && wanted >= 1 && wanted <= MAX_QUESTIONS;
  const lectureQuestions = useMemo(() => (planLecture && existing ? existing.filter((q) => q.lectureIds.includes(planLecture.id)) : []), [planLecture?.id, existing]);
  const plan = useMemo(() => {
    if (!planLecture || !countOk) return [];
    const slides = slidesToSend(planLecture);
    const off = planLecture.report.topics.filter((t) => !topicOff.has(`${planLecture.id}:${t.id}`));
    return buildBlueprint({
      slides,
      topics: off,
      count: wanted,
      examStyle: course.examStyle,
      existing: lectureQuestions.map((q) => ({ topic: q.topic, slides: q.sources.filter((s) => s.lectureId === planLecture.id).map((s) => s.slide), type: q.type })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slidesToSend reads ranges, topicOff and loaded, all listed
  }, [planLecture?.id, planLecture?.updatedAt, countOk, wanted, course.examStyle, lectureQuestions, ranges, topicOff, loaded]);
  const requests = useMemo(() => splitIntoRequests(plan, outputCap), [plan, outputCap]);
  const thisRequest = requests[0] ?? [];
  const planned: PlannedSlot[] = thisRequest.map(({ n: _n, ...rest }) => rest);
  /** Questions you already have for this lecture, newest first, so the AI does not write them again. */
  const alreadyAsked = useMemo(() => [...lectureQuestions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).map((q) => q.prompt.replace(/\s+/g, ' ').trim().slice(0, 200)), [lectureQuestions]);

  const counts = packCounts({ wants, amount, outputTokens: outputCap, ...(planned.length > 0 ? { blueprint: planned } : {}) });
  const countText = [counts.questions > 0 && `시험 문제 ${counts.questions}개`, counts.cards > 0 && `플래시카드 ${counts.cards}장`, counts.notes > 0 && `노트 ${counts.notes}개`].filter(Boolean).join(', ');
  const nothingToAsk = wants.questions && countOk && !!planLecture && ready && !noSlides && plan.length === 0;

  const go = async () => {
    setBusy(true);
    setError(undefined);
    const reply = await askAi({
      task: 'generate',
      lectureMarkdown: markdown,
      wants,
      amount,
      ...(course.examStyle?.trim() ? { examStyle: course.examStyle.trim().slice(0, LIMITS.examStyle) } : {}),
      ...(planned.length > 0 ? { blueprint: planned, ...(alreadyAsked.length > 0 ? { alreadyAsked } : {}) } : {}),
    });
    setBusy(false);
    if (!reply.ok) setError(reply.message);
    else {
      onGenerated(reply.text, false, planned.length > 0 ? planned : undefined);
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      wide
      title="AI로 학습 자료 만들기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button variant="primary" disabled={busy || !usable || !consent || picked.size === 0 || tooBig || none || badRange || markdown.length < 20 || (wants.questions && !countOk)} onClick={() => void go()}>
            {busy ? '쓰는 중…' : '만들고 확인하기'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="max-w-prose text-ink-2">AI가 슬라이드로 플래시카드와 시험 문제 초안을 씁니다. 아직 아무것도 저장하지 않습니다. 먼저 확인 화면에서 인용문을 모두 실제 슬라이드와 대조하고, 모든 항목은 승인을 기다립니다.</p>
        {!usable && (
          <p className="rounded-[var(--radius-control)] border border-warn/40 bg-warn-soft/40 px-3 py-2">
            {blocker}{' '}
            {ai.phase === 'ready' && <Link to="/settings" className="text-accent underline underline-offset-2">설정 → AI 열기</Link>}
          </p>
        )}
        <fieldset>
          <legend className="font-medium">강의</legend>
          <ul className="mt-1 flex flex-col gap-1">
            {lectures.map((l) => (
              <li key={l.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={picked.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(l.id);
                      else next.delete(l.id);
                      setPicked(next);
                    }}
                  />
                  {l.title} <span className="text-ink-3">(슬라이드 {l.slideCount}장)</span>
                </label>
                {picked.has(l.id) && l.slideCount > 1 && (
                  <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-ink-2">
                    <span>보낼 슬라이드 범위</span>
                    <TextInput
                      inputMode="numeric"
                      aria-label={`${l.title}의 첫 슬라이드`}
                      className="!w-16 !min-h-8 text-center"
                      value={ranges[l.id]?.from ?? '1'}
                      onChange={(e) => setRanges({ ...ranges, [l.id]: { from: e.target.value.replace(/\D/g, ''), to: ranges[l.id]?.to ?? String(l.slideCount) } })}
                    />
                    <span aria-hidden>~</span>
                    <TextInput
                      inputMode="numeric"
                      aria-label={`${l.title}의 마지막 슬라이드`}
                      className="!w-16 !min-h-8 text-center"
                      value={ranges[l.id]?.to ?? String(l.slideCount)}
                      onChange={(e) => setRanges({ ...ranges, [l.id]: { from: ranges[l.id]?.from ?? '1', to: e.target.value.replace(/\D/g, '') } })}
                    />
                    {!rangeOf(l).ok && <span role="alert" className="text-bad">슬라이드 번호는 1부터 {l.slideCount}까지의 정수로 쓰고, 첫 번호가 마지막 번호보다 크면 안 됩니다.</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {wants.questions && chosen.length > 1 && <p className="mt-1 text-ink-2">시험 문제는 강의 하나씩 계획하므로 “{sending[0]?.title}”만 씁니다.</p>}
        </fieldset>
        {planLecture && planLecture.report.topics.length > 1 && (
          <details className="rounded-[var(--radius-control)] border border-rule">
            <summary className="cursor-pointer px-3 py-2 font-medium">물어볼 주제({planLecture.report.topics.length}개 중 {planLecture.report.topics.filter((t) => !topicOff.has(`${planLecture.id}:${t.id}`)).length}개)</summary>
            <ul className="flex flex-col gap-1 border-t border-rule px-3 py-2">
              {planLecture.report.topics.map((t) => (
                <li key={t.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={!topicOff.has(`${planLecture.id}:${t.id}`)}
                      onChange={(e) => {
                        const next = new Set(topicOff);
                        if (e.target.checked) next.delete(`${planLecture.id}:${t.id}`);
                        else next.add(`${planLecture.id}:${t.id}`);
                        setTopicOff(next);
                      }}
                    />
                    <span className="min-w-0 truncate">{t.title}</span>
                    <span className="shrink-0 text-ink-3">{t.startSlide === t.endSlide ? `슬라이드 ${t.startSlide}` : `슬라이드 ${t.startSlide}–${t.endSlide}`}</span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(['cards', 'questions', 'notes'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--accent)]" checked={wants[k]} onChange={(e) => setWants({ ...wants, [k]: e.target.checked })} /> {k === 'cards' ? '플래시카드' : k === 'questions' ? '시험 문제' : '노트'}
            </label>
          ))}
          {(wants.cards || wants.notes) && (
            <label className="flex items-center gap-2">
              양
              <Select value={amount} onChange={(e) => setAmount(e.target.value as typeof amount)} className="w-auto">
                <option value="few">조금</option>
                <option value="normal">보통</option>
                <option value="many">많이</option>
              </Select>
            </label>
          )}
          {wants.questions && (
            <label className="flex items-center gap-2">
              계획할 시험 문제 수
              <TextInput inputMode="numeric" aria-label="계획할 시험 문제 수" className="!w-16 !min-h-8 text-center" value={questionCount} onChange={(e) => setQuestionCount(e.target.value.replace(/\D/g, ''))} />
            </label>
          )}
        </div>
        {wants.questions && !countOk && <p role="alert" className="text-bad">문제는 1개부터 {MAX_QUESTIONS}개까지 계획할 수 있습니다.</p>}
        {countText && (
          <p className="text-ink-2">
            이 요청은 {countText}을(를) 요구합니다. AI는 답 하나에 약 {outputCap.toLocaleString('ko-KR')}토큰까지만 쓰도록 요청받으므로, 더 큰 세트는 다른 슬라이드로 여러 번 요청해야 하며 매번 먼저 보여 드립니다.
          </p>
        )}
        {wants.questions && plan.length > 0 && (
          <section aria-label="시험 계획" className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 px-3 py-2">
            <h3 className="font-medium">
              시험 계획: 문제 {plan.length}개, 요청 {requests.length}번
            </h3>
            <p className="text-ink-2">이 자료에 맞게 내 기기에서 짠 구성입니다. 실제 시험을 예측하지 않습니다{course.examStyle?.trim() ? '. 저장한 출제 안내를 따릅니다' : ''}. 이번 요청은 처음 {thisRequest.length}개를 씁니다. 가져온 뒤 다시 열면 다음 문제를 쓰며, 이미 있는 문제는 건너뜁니다.</p>
            <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5 text-[13px] text-ink-2">
              {plan.map((s) => (
                <li key={s.n} className={thisRequest.some((x) => x.n === s.n) ? 'font-medium text-ink' : ''}>
                  {describeSlot(s)}
                  {thisRequest.some((x) => x.n === s.n) ? ' (이번 요청)' : ''}
                </li>
              ))}
            </ol>
          </section>
        )}
        {nothingToAsk && <p className="text-ink-2">이 슬라이드는 텍스트가 너무 적어 시험 문제를 계획할 수 없으므로 일반적인 세트를 요청합니다.</p>}
        <details className="rounded-[var(--radius-control)] border border-rule bg-sunken/40">
          <summary className="cursor-pointer px-3 py-2 font-medium">
            {dest.sentTo}에 보낼 내용: 강의 {sending.length}개의 텍스트
            {sending.map((l) => (rangeOf(l).ok && l.slideCount > 1 && (rangeOf(l).from !== 1 || rangeOf(l).to !== l.slideCount) ? `, ${l.title}의 슬라이드 ${rangeOf(l).from}–${rangeOf(l).to}` : '')).join('')}(약 {Math.round(markdown.length / 4).toLocaleString('ko-KR')}토큰)
          </summary>
          <div className="border-t border-rule px-3 py-3">
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs">{markdown || '(강의를 고르세요)'}</pre>
            {planned.length > 0 && <p className="mt-2 text-ink-2">함께 보내는 것: 이번 요청의 위 계획(문제 {planned.length}개마다 유형, 난이도, 배점, 주제, 슬라이드).</p>}
            {planned.length > 0 && alreadyAsked.length > 0 && (
              <div className="mt-2 text-ink-2">
                <p>반복하지 않도록 함께 보내는 것: 이 강의에 이미 있는 문제 {alreadyAsked.length}개의 문장.</p>
                <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-5 text-[13px]">
                  {alreadyAsked.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2 text-ink-2">그리고 형식에 대한 고정 지시문을 보냅니다. 슬라이드 텍스트만 보내며 그림, 파일, 계정 정보는 보내지 않습니다.</p>
          </div>
        </details>
        {noSlides && <p role="alert" className="text-bad">보낼 슬라이드가 남아 있지 않습니다. 주제를 다시 켜거나 슬라이드 범위를 넓히세요.</p>}
        {tooBig && <p role="alert" className="text-bad">요청 한 번에 보내기에는 텍스트가 너무 많습니다. 강의를 줄여서 고르세요.</p>}
        {!consent && usable && (
          <label className="flex items-start gap-2 rounded-[var(--radius-control)] border border-warn/40 bg-warn-soft/40 p-3">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" onChange={(e) => e.target.checked && void setConsent(new Date().toISOString().slice(0, 10))} />
            <span>{dest.consent}</span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-bad">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
