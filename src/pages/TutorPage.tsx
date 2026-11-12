import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useOutletContext, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookmarkPlus, Copy, MessageSquarePlus, NotebookPen, Send, Trash2 } from 'lucide-react';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useNotes, useSearch, useSetting, useSlides } from '@/app/data';
import { useToast } from '@/app/toast';
import { getDb } from '@/core/db/db';
import { displayTitle } from '@/core/pptx/topics';
import { createCard, createNote } from '@/core/study/store';
import type { TutorMessageRow } from '@/core/study/types';
import { appendMessage, createSession, deleteSession, toHistory } from '@/core/tutor/chat';
import { buildContext, citesToSources, slideContextText, type BuiltContext, type ContextSlide } from '@/core/tutor/context';
import { LIMITS, TUTOR_MODE_LABEL, TUTOR_MODES, type TutorMode } from '@/core/tutor/contract';
import { lessonParts, lessonQuestion } from '@/core/tutor/lesson';
import { pickNotes, type NoteContext } from '@/core/tutor/notes-context';
import { gapMessages } from '@/core/tutor/gaps';
import { parseTutorReply, relabelCitations } from '@/core/tutor/parse';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { BasisChip, SourceList } from '@/ui/study/Sources';
import { Button, Callout, Dialog, Select, Spinner, TextArea } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';
import { aiBlocker } from '@/ui/ai/blocker';
import { AI_DESTINATION as dest } from '@/ui/ai/destination';

const db = getDb();

interface Pick {
  lectureId: string;
  slide: number;
}

export function TutorPage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const [params] = useSearchParams();
  // Other screens (a flashcard, an exam question) can open the tutor with the question already typed; it travels in router state, not in the address.
  const preset = (useLocation().state as { question?: unknown } | null)?.question;
  const toast = useToast();
  const ai = useAiServer();
  const search = useSearch();
  const [consent, setConsent] = useSetting<string>(dest.consentKey);

  useEffect(() => {
    void refreshAi();
  }, []);

  // ---- chats ------------------------------------------------------------------
  const sessions = useLiveQuery(async () => (await db.tutorSessions.where('courseId').equals(course.id).toArray()).sort((a, b) => b.updatedAt - a.updatedAt), [course.id]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const messages = useLiveQuery(async () => (activeId ? await db.tutorMessages.where('sessionId').equals(activeId).sortBy('createdAt') : []), [activeId]);
  const [deleting, setDeleting] = useState<string | undefined>();

  // ---- what to send -----------------------------------------------------------
  const lectureParam = params.get('lecture');
  const slideParam = Number(params.get('slide'));
  const [scope, setScope] = useState<'auto' | 'chosen'>(lectureParam ? 'chosen' : 'auto');
  const [lectureId, setLectureId] = useState<string | undefined>(lectureParam && lectures.some((l) => l.id === lectureParam) ? lectureParam : lectures[0]?.id);
  const [picked, setPicked] = useState<Set<number>>(Number.isInteger(slideParam) && slideParam > 0 ? new Set([slideParam]) : new Set());
  const [mode, setMode] = useState<TutorMode>('explain');
  const [question, setQuestion] = useState(typeof preset === 'string' ? preset.slice(0, LIMITS.question) : '');
  const [sticky, setSticky] = useState<Pick[]>([]);
  const slides = useSlides(lectureId);
  // ---- guided lesson: the lecture's own topics in slide order, a few slides at a time ----
  const [lessonAt, setLessonAt] = useState<number | undefined>();
  const lecture = lectures.find((l) => l.id === lectureId);
  const parts = useMemo(() => (lecture ? lessonParts(lecture.report.topics, lecture.slideCount) : []), [lecture]);
  /** The parts of the lesson that were really sent in this chat, so a later part can say what has been covered. */
  const [covered, setCovered] = useState<number[]>([]);
  const resetLesson = () => {
    setLessonAt(undefined);
    setCovered([]);
  };
  const startPart = (i: number) => {
    const part = parts[i];
    if (!part) return;
    setScope('chosen');
    setPicked(new Set(part.slides));
    setMode('steps');
    const before = parts.filter((_, k) => k < i && covered.includes(k)); // only parts that were really taught count as covered
    setQuestion(lessonQuestion(part, before.length === 0, before));
    setLessonAt(i);
  };
  const notes = useNotes(course.id);
  const [withNotes, setWithNotes] = useState(false);
  const notePicks = useMemo<NoteContext[]>(() => (withNotes ? pickNotes(notes ?? [], question) : []), [withNotes, notes, question]);
  const notesKey = notePicks.map((n) => n.noteId).join(',');

  const autoPicks = useMemo<Pick[]>(() => {
    const q = question.trim();
    const all = q.length >= 3 ? search.search(q, { courseId: course.id }, 8) : [];
    // Only clearly relevant slides leave the device: at least 40% of the best match's score, and at most four.
    const best = all[0]?.score ?? 0;
    const hits = all.filter((h) => h.score >= best * 0.4).slice(0, 4);
    const seen = new Set<string>();
    const out: Pick[] = [];
    for (const h of hits) {
      const k = `${h.lectureId}:${h.slide}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ lectureId: h.lectureId, slide: h.slide });
      }
    }
    return out.length > 0 ? out : sticky;
  }, [question, search, course.id, sticky]);

  const picks = useMemo<Pick[]>(() => (scope === 'chosen' && lectureId ? [...picked].sort((a, b) => a - b).map((slide) => ({ lectureId, slide })) : autoPicks), [scope, lectureId, picked, autoPicks]);
  const picksKey = picks.map((p) => `${p.lectureId}:${p.slide}`).join(',');

  const [context, setContext] = useState<BuiltContext | undefined>();
  useEffect(() => {
    let cancelled = false;
    void loadContext(picks, lectures, notePicks).then((c) => !cancelled && setContext(c));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picksKey and notesKey identify the picks
  }, [picksKey, notesKey, lectures]);

  // ---- sending ----------------------------------------------------------------
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [messages?.length, busy]);

  const blocker = aiBlocker(ai);
  const usable = blocker === undefined;

  const send = async (text = question) => {
    const q = text.trim();
    if (!q || busy || !usable || !consent) return;
    const built = context ?? (await loadContext(picks, lectures, notePicks));
    if (built.excerpts.length === 0) {
      toast.show('슬라이드를 하나 이상 고르거나, 슬라이드에 나오는 내용을 물어보세요.', 'error');
      return;
    }
    setBusy(true);
    try {
      let sid = activeId;
      if (!sid) {
        sid = (await createSession(db, { courseId: course.id, title: q.slice(0, 80), mode })).id;
        setActiveId(sid);
      }
      const history = toHistory(messages ?? []);
      await appendMessage(db, { sessionId: sid, courseId: course.id, role: 'user', text: q, sent: { slides: built.excerpts.length, chars: built.chars, mode } });
      setQuestion('');
      const reply = await askAi({ task: 'tutor', mode, question: q, excerpts: built.excerpts, history, courseName: course.name, ...(course.examStyle?.trim() ? { examStyle: course.examStyle.trim().slice(0, LIMITS.examStyle) } : {}), ...(built.gaps.length > 0 ? { gaps: built.gaps } : {}) });
      if (reply.ok) {
        // What the model may legitimately quote: the slides it was sent (with their titles) and the student's own words.
        const known = [...built.excerpts.map((e) => `${e.title}\n${e.text}`), q, ...history.filter((h) => h.role === 'user').map((h) => h.text)];
        const parsed = parseTutorReply(reply.text, built.excerpts.map((e) => e.ref), built.noteRefs, known);
        // The labels S1, S2, … mean something only in this request, so the stored text names the real slides instead.
        const text = relabelCitations(parsed.body, (ref) => built.refs.get(ref)?.slide, built.noteRefs);
        await appendMessage(db, {
          sessionId: sid,
          courseId: course.id,
          role: 'assistant',
          text: text || '(튜터가 빈 답을 보냈습니다.)',
          basis: parsed.basis,
          sources: citesToSources(parsed.cites, built.refs),
          followups: parsed.followups,
          paidBy: 'chatgpt-plan' as const,
          ...(parsed.unverifiedQuotes.length > 0 ? { quoteWarnings: parsed.unverifiedQuotes.map((s) => s.slice(0, 300)) } : {}),
        });
        setSticky(picks);
        if (lessonAt !== undefined) setCovered((c) => (c.includes(lessonAt) ? c : [...c, lessonAt]));
      } else {
        await appendMessage(db, { sessionId: sid, courseId: course.id, role: 'assistant', text: '', error: reply.message.slice(0, 500) });
      }
    } finally {
      setBusy(false);
    }
  };

  const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === 'user');

  return (
    <div>
      <h2 className="sr-only">AI 튜터</h2>
      {blocker && (
        <div className="mb-4">
          <Callout tone={ai.phase === 'unavailable' ? 'info' : 'warn'} title={ai.phase === 'unavailable' ? '여기에는 AI가 없습니다' : '튜터가 아직 준비되지 않았습니다'}>
            <p>
              {blocker} 앱의 다른 기능은 모두 됩니다. {ai.phase === 'ready' && <Link to="/settings" className="text-accent underline underline-offset-2">설정 → AI 열기</Link>}
            </p>
          </Callout>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <aside aria-label="대화와 슬라이드" className="flex flex-col gap-6">
          <section aria-labelledby="chats-h">
            <div className="flex items-center justify-between">
              <h3 id="chats-h" className="font-semibold">
                대화
              </h3>
              <Button
                size="sm"
                onClick={() => {
                  setActiveId(undefined);
                  resetLesson();
                }}
              >
                <MessageSquarePlus className="size-4" aria-hidden /> 새 대화
              </Button>
            </div>
            {sessions && sessions.length > 0 ? (
              <ul className="mt-2 flex flex-col">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-1 border-t border-rule first:border-t-0">
                    <button type="button" className={`min-w-0 flex-1 truncate py-2 text-left text-sm ${s.id === activeId ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink'}`} aria-current={s.id === activeId ? 'true' : undefined} onClick={() => { setActiveId(s.id); if (s.id !== activeId) resetLesson(); }}>
                      {s.title}
                    </button>
                    <button type="button" aria-label={`대화 삭제: ${s.title}`} className="rounded p-1 text-ink-3 hover:text-bad" onClick={() => setDeleting(s.id)}>
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-ink-3">대화는 이 기기에만 보관됩니다.</p>
            )}
          </section>

          <section aria-labelledby="ctx-h">
            <h3 id="ctx-h" className="font-semibold">
              사용할 슬라이드
            </h3>
            <div role="radiogroup" aria-label="슬라이드 선택 방식" className="mt-2 flex flex-col gap-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" className="accent-[var(--accent)]" checked={scope === 'auto'} onChange={() => setScope('auto')} /> 질문에 맞는 슬라이드 찾기
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" className="accent-[var(--accent)]" checked={scope === 'chosen'} onChange={() => setScope('chosen')} /> 내가 고른 슬라이드
              </label>
            </div>
            {scope === 'chosen' && (
              <div className="mt-3">
                {lectures.length === 0 ? (
                  <p className="text-sm text-ink-3">먼저 이 과목에 강의를 추가하세요.</p>
                ) : (
                  <>
                    <label className="block text-sm">
                      <span className="sr-only">강의</span>
                      <Select value={lectureId ?? ''} onChange={(e) => { setLectureId(e.target.value); setPicked(new Set()); resetLesson(); }}>
                        {lectures.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.title}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {parts.length > 1 && (
                      <div className="mt-3">
                        <h4 className="text-sm font-medium">순서대로 배우기</h4>
                        <p className="text-[13px] text-ink-3">부분을 고르면 그 슬라이드를 선택하고 질문을 써 줍니다. 보낼 내용을 확인한 뒤 보내기를 누르세요.</p>
                        <ol className="mt-1 max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-rule" aria-label="수업 단계">
                          {parts.map((p, i) => (
                            <li key={p.n} className="border-t border-rule first:border-t-0">
                              <button type="button" aria-current={lessonAt === i ? 'step' : undefined} className={`w-full px-2 py-1.5 text-left text-sm ${lessonAt === i ? 'bg-accent-soft font-medium text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'}`} onClick={() => startPart(i)}>
                                <span className="tabular-nums text-ink-3">{p.n}.</span> {p.title}
                              </button>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {!slides ? (
                      <Spinner />
                    ) : (
                      <ul className="mt-2 max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-rule" aria-label="슬라이드">
                        {slides.map((s) => (
                          <li key={s.index} className="border-t border-rule first:border-t-0">
                            <label className="flex items-start gap-2 px-2 py-1.5 text-sm">
                              <input
                                type="checkbox"
                                className="mt-0.5 accent-[var(--accent)]"
                                checked={picked.has(s.index)}
                                onChange={(e) => {
                                  const next = new Set(picked);
                                  if (e.target.checked) next.add(s.index);
                                  else next.delete(s.index);
                                  setPicked(next);
                                }}
                              />
                              <span className="min-w-0">
                                <span className="tabular-nums text-ink-3">{s.index}.</span> {displayTitle(s)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    {picked.size > 0 && (
                      <button type="button" className="mt-1 text-sm text-accent underline underline-offset-2" onClick={() => setPicked(new Set())}>
                        선택 지우기
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="notes-h">
            <h3 id="notes-h" className="font-semibold">
              내 노트
            </h3>
            <label className="mt-2 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={withNotes} onChange={(e) => setWithNotes(e.target.checked)} />
              <span>질문에 맞는 내 노트도 최대 3개까지 씁니다. 노트도 함께 보내지며, 교수의 자료가 아니라 내 노트라고 표시됩니다.</span>
            </label>
          </section>

          <section aria-labelledby="mode-h">
            <h3 id="mode-h" className="font-semibold">
              어떻게 가르칠까요?
            </h3>
            <label className="mt-2 block text-sm">
              <span className="sr-only">설명 방식</span>
              <Select value={mode} onChange={(e) => setMode(e.target.value as TutorMode)}>
                {TUTOR_MODES.map((m) => (
                  <option key={m} value={m}>
                    {TUTOR_MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </label>
          </section>
        </aside>

        <section aria-label="대화 내용" className="min-w-0">
          <div className="min-h-[14rem] rounded-[var(--radius-panel)] border border-rule bg-surface p-4 md:p-6">
            {!messages || messages.length === 0 ? (
              <div className="text-sm text-ink-2">
                <p className="font-medium text-ink">강의에 대해 물어보세요.</p>
                <p className="mt-1 max-w-prose">튜터는 고른 슬라이드로 답하고, 각 내용이 어느 슬라이드에서 왔는지 알려 줍니다. 슬라이드에 없는 내용을 더하거나 확실하지 않을 때도 그렇다고 말합니다.</p>
                {parts.length > 1 && (
                  <Button className="mt-3" onClick={() => startPart(0)}>
                    처음부터 차근차근 배우기
                  </Button>
                )}
              </div>
            ) : (
              <ol className="flex flex-col gap-6" aria-label="메시지">
                {messages.map((m) => (
                  <Message key={m.id} m={m} courseId={course.id} prevQuestion={questionBefore(messages, m)} onFollowUp={(t) => setQuestion(t)} />
                ))}
              </ol>
            )}
            {busy && (
              <div className="mt-4 flex items-center gap-2 text-sm text-ink-2" role="status">
                <Spinner label="튜터가 생각하는 중" />
              </div>
            )}
            <div ref={bottom} />
          </div>

          {lessonAt !== undefined && parts[lessonAt + 1] && messages && messages.length > 0 && !busy && (
            <div className="mt-3">
              <Button onClick={() => startPart(lessonAt + 1)}>다음 부분: {parts[lessonAt + 1]!.title}</Button>
            </div>
          )}

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="tutor-q" className="sr-only">
              내 질문
            </label>
            <TextArea
              id="tutor-q"
              rows={3}
              value={question}
              maxLength={LIMITS.question}
              placeholder={lastUser ? '이어서 물어보세요…' : '예: 전이 함수란 무엇이고 상태와 어떻게 다른가요?'}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {context && context.gaps.length > 0 && (
              <div role="note" aria-label="이 슬라이드에서 찾은 빈틈" className="mt-2 rounded-[var(--radius-control)] border border-rule px-3 py-2 text-[13px] text-ink-2">
                <p className="font-medium text-ink">튜터가 이 슬라이드에서 짚어 줄 빈틈</p>
                <ul className="mt-1 list-disc pl-5">
                  {context.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
            <WhatWillBeSent context={context} mode={mode} examStyle={!!course.examStyle?.trim()} scope={scope} sentTo={dest.sentTo} />
            {!consent && usable && (
              <div className="mt-3 rounded-[var(--radius-control)] border border-warn/40 bg-warn-soft/40 p-3 text-sm">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" onChange={(e) => e.target.checked && void setConsent(new Date().toISOString().slice(0, 10))} />
                  <span>{dest.consent}</span>
                </label>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" disabled={busy || !usable || !consent || !question.trim()}>
                <Send className="size-4" aria-hidden /> {context && context.excerpts.length > 0 ? `슬라이드 ${context.excerpts.length}장과 함께 보내기` : '보내기'}
              </Button>
              <span className="text-[13px] text-ink-3">Ctrl+Enter로 보냅니다. 내 ChatGPT 플랜 사용량에 포함됩니다.</span>
            </div>
          </form>
        </section>
      </div>

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title="이 대화를 삭제할까요?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              취소
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = deleting;
                setDeleting(undefined);
                if (id) void deleteSession(db, id).then(() => id === activeId && setActiveId(undefined));
              }}
            >
              대화 삭제
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">메시지가 이 기기에서 지워집니다. 이 대화에서 저장한 노트와 플래시카드는 남습니다.</p>
      </Dialog>
    </div>
  );
}

function questionBefore(messages: TutorMessageRow[], m: TutorMessageRow): string {
  const i = messages.findIndex((x) => x.id === m.id);
  for (let k = i - 1; k >= 0; k--) if (messages[k]!.role === 'user') return messages[k]!.text;
  return '';
}

/** Loads the picked slides from the local library and labels them S1, S2, … (nothing is sent by this). */
async function loadContext(picks: Pick[], lectures: { id: string; title: string; revision: number; meta: { slideHeight: number } }[], notes: NoteContext[] = []): Promise<BuiltContext> {
  const out: ContextSlide[] = [];
  for (const p of picks) {
    const lec = lectures.find((l) => l.id === p.lectureId);
    const row = await db.slides.get([p.lectureId, p.slide]);
    if (!lec || !row) continue;
    out.push({ lectureId: lec.id, lectureTitle: lec.title, revision: lec.revision, slide: p.slide, title: displayTitle(row), text: slideContextText(row, lec.meta.slideHeight), gaps: gapMessages([row]) });
  }
  // The student's own notes go last, labelled as notes, so the tutor never mistakes them for the lecture.
  for (const n of notes) out.push({ kind: 'note', lectureId: n.noteId, lectureTitle: '내 노트', revision: 0, slide: 0, title: n.title, text: n.text });
  return buildContext(out);
}

function WhatWillBeSent({ context, mode, examStyle, scope, sentTo }: { context: BuiltContext | undefined; mode: TutorMode; examStyle: boolean; scope: 'auto' | 'chosen'; sentTo: string }) {
  const n = context?.excerpts.length ?? 0;
  const noteCount = context?.excerpts.filter((e) => e.kind === 'note').length ?? 0;
  const slideCount = n - noteCount;
  return (
    <details className="mt-3 rounded-[var(--radius-control)] border border-rule bg-sunken/40 text-sm">
      <summary className="cursor-pointer px-3 py-2 font-medium">
        {sentTo}에 보낼 내용: 내 질문{n > 0 ? `, 슬라이드 ${slideCount}장${noteCount > 0 ? `, 내 노트 ${noteCount}개` : ''}(약 ${context!.approxTokens.toLocaleString('ko-KR')}토큰)` : '(아직 슬라이드 없음)'}
      </summary>
      <div className="border-t border-rule px-3 py-3">
        {n === 0 ? (
          <p className="text-ink-2">{scope === 'auto' ? '질문을 입력하세요. 질문에 맞는 슬라이드를 자동으로 골라 보내기 전에 여기에 보여 줍니다.' : '왼쪽에서 슬라이드를 하나 이상 고르세요.'}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {context!.excerpts.map((e) => (
                <li key={e.ref}>
                  <p className="font-medium">
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-xs">{e.ref}</span> {e.kind === 'note' ? `내 노트: ${e.title}` : `${e.lectureTitle}, 슬라이드 ${e.slide}: ${e.title}`}
                  </p>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-rule bg-surface p-2 font-mono text-xs">{e.text}</pre>
                </li>
              ))}
            </ul>
            {(context!.dropped > 0 || context!.shortened > 0) && <p className="mt-2 text-warn">크기 한도를 지키려고 {context!.dropped > 0 ? `슬라이드 ${context!.dropped}장을 뺐고 ` : ''}{context!.shortened > 0 ? `${context!.shortened}장을 줄였습니다` : ''}.</p>}
          </>
        )}
        <p className="mt-3 text-ink-2">
          함께 보내는 것: 설명 방식(“{TUTOR_MODE_LABEL[mode]}”), 이 대화의 이전 메시지{(context?.gaps.length ?? 0) > 0 ? `, 위에 보인 빈틈 메모 ${context!.gaps.length}개(내 기기에서 찾음)` : ''}{examStyle ? ', 과목 정보의 출제 안내' : ''}. 그 밖에는 아무것도 보내지 않습니다. 파일, 이미지, 계정 정보, 다른 슬라이드는 보내지 않으며 슬라이드 그림도 보내지 않고 텍스트만 보냅니다.
        </p>
      </div>
    </details>
  );
}

function Message({ m, courseId, prevQuestion, onFollowUp }: { m: TutorMessageRow; courseId: string; prevQuestion: string; onFollowUp: (t: string) => void }) {
  const toast = useToast();
  if (m.role === 'user') {
    return (
      <li className="ml-auto max-w-[85%]">
        <div className="rounded-[var(--radius-control)] bg-accent-soft px-3 py-2 text-[15px]">{m.text}</div>
        {m.sent && (
          <p className="mt-1 text-right text-xs text-ink-3">
            슬라이드 {m.sent.slides}장과 함께 보냄 · {TUTOR_MODE_LABEL[m.sent.mode]}
          </p>
        )}
      </li>
    );
  }
  if (m.error) {
    return (
      <li role="alert" className="rounded-[var(--radius-control)] border border-bad/40 bg-bad-soft/40 px-3 py-2 text-sm text-ink">
        <span className="font-medium">답을 받지 못했습니다.</span> {m.error}
      </li>
    );
  }
  const sources = m.sources ?? [];
  const lectureId = sources[0]?.lectureId;
  const saveNote = async () => {
    await createNote(db, { courseId, ...(lectureId ? { lectureId } : {}), title: (prevQuestion || '튜터 답변').slice(0, 80), kind: 'custom', blocks: [{ text: m.text, origin: 'ai', basis: m.basis ?? 'uncertain', sources }] });
    toast.show('노트로 저장했습니다. AI가 쓴 것으로 표시됩니다.', 'ok');
  };
  const makeCard = async () => {
    if (!prevQuestion) return;
    await createCard(db, { courseId, ...(lectureId ? { lectureId } : {}), type: 'qa', front: prevQuestion.slice(0, 2_000), back: m.text.slice(0, 18_000), basis: m.basis ?? 'uncertain', sources, origin: 'ai', status: 'pending' });
    toast.show('승인을 기다리는 플래시카드로 추가했습니다.', 'ok');
  };
  return (
    <li className="max-w-[48rem]">
      <LazyMarkdown>{m.text}</LazyMarkdown>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {m.basis && <BasisChip basis={m.basis} sources={sources} />}
        <SourceList sources={sources} />
        {m.paidBy === 'chatgpt-plan' && <span className="text-xs text-ink-3">ChatGPT 플랜 사용</span>}
      </div>
      {m.quoteWarnings && m.quoteWarnings.length > 0 && (
        <p className="mt-2 text-sm text-warn">
          따옴표 안에 있지만 보낸 슬라이드에서 찾지 못한 표현입니다(튜터가 자기 말로 바꿨을 수 있습니다): {m.quoteWarnings.map((q) => `“${q}”`).join(' · ')}
        </p>
      )}
      {m.truncated && (
        <p className="mt-2 text-sm text-warn">
          이 답은 길이 한도에 닿아 중간에 끝났습니다.{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => onFollowUp('멈춘 곳부터 이어서 설명해 주세요.')}>
            이어서 쓰게 하기
          </button>
        </p>
      )}
      {m.followups && m.followups.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="이어서 할 질문">
          {m.followups.map((f) => (
            <button key={f} type="button" className="rounded-full border border-rule-strong bg-surface px-3 py-1 text-sm hover:bg-sunken" onClick={() => onFollowUp(f)}>
              {f}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <button type="button" className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink" onClick={() => void saveNote()}>
          <NotebookPen className="size-4" aria-hidden /> 노트로 저장
        </button>
        <button type="button" className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink disabled:opacity-50" disabled={!prevQuestion} onClick={() => void makeCard()}>
          <BookmarkPlus className="size-4" aria-hidden /> 플래시카드 만들기
        </button>
        <button type="button" className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink" onClick={() => void navigator.clipboard?.writeText(m.text).then(() => toast.show('복사했습니다.', 'ok'))}>
          <Copy className="size-4" aria-hidden /> 복사
        </button>
      </div>
    </li>
  );
}
