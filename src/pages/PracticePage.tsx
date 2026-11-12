import { useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { Check, FilePen, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createExam, startAttempt, deleteAttempt } from '@/core/study/attempts';
import { missedQuestionIds, scoreAttempt, weakTopics } from '@/core/study/exam';
import { deleteQuestions, setQuestionStatus } from '@/core/study/store';
import { QUESTION_TYPES, QUESTION_TYPE_LABEL, type AttemptRow, type ExamConfig, type QuestionRow } from '@/core/study/types';
import { useAttempts, useExams, useQuestions } from '@/app/data';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Menu } from '@/ui/Menu';
import { ExamBuilder } from '@/ui/study/ExamBuilder';
import { QuestionEditor } from '@/ui/study/QuestionEditor';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Dialog, EmptyState, Select, Spinner, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';

const db = getDb();

export function PracticePage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const bank = useQuestions(course.id);
  const exams = useExams(course.id);
  const attempts = useAttempts(course.id);
  const toast = useToast();
  const navigate = useNavigate();
  const [building, setBuilding] = useState(false);
  const [preset, setPreset] = useState<Partial<ExamConfig> | undefined>();
  const [editing, setEditing] = useState<QuestionRow | undefined>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<QuestionRow[] | undefined>();
  const [text, setText] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [lectureFilter, setLectureFilter] = useState('');

  const byId = useMemo(() => new Map((bank ?? []).map((q) => [q.id, q])), [bank]);
  const examById = useMemo(() => new Map((exams ?? []).map((e) => [e.id, e])), [exams]);
  const weak = useMemo(() => weakTopics(attempts ?? [], byId, 2, 60), [attempts, byId]);

  if (!bank || !exams || !attempts) return <Spinner />;

  const approved = bank.filter((q) => q.status === 'approved');
  const pending = bank.filter((q) => q.status === 'pending');
  const lectureTitle = (id: string) => lectures.find((l) => l.id === id)?.title;
  const q = text.trim().toLowerCase();
  const shown = bank
    .filter((x) => !typeFilter || x.type === typeFilter)
    .filter((x) => !statusFilter || x.status === statusFilter)
    .filter((x) => !lectureFilter || x.lectureIds.includes(lectureFilter))
    .filter((x) => !q || x.prompt.toLowerCase().includes(q) || (x.topic ?? '').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);

  const open = (p?: Partial<ExamConfig>) => {
    setPreset(p);
    setBuilding(true);
  };

  const repeatMissed = async (a: AttemptRow) => {
    const exam = examById.get(a.examId);
    if (!exam) return;
    const score = scoreAttempt(exam.questionIds.map((id) => byId.get(id)).filter((x): x is QuestionRow => !!x), a);
    const ids = missedQuestionIds(score);
    if (ids.length === 0) {
      toast.show('그 응시에서는 모든 문제가 만점이었습니다.', 'ok');
      return;
    }
    const e = await createExam(db, course.id, { ...exam.config, title: `다시 풀기: ${exam.config.title}`, count: ids.length, totalMarks: undefined }, ids);
    navigate(`/exam/${(await startAttempt(db, e.id)).id}`);
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="prac-h">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="prac-h" className="text-lg font-semibold">
              연습과 시험
            </h2>
            <p className="text-sm text-ink-2">
              {approved.length === 0 ? '문제를 추가하거나 가져온 뒤 그 문제로 시험을 만드세요.' : `문제 은행에 승인한 문제가 ${approved.length}개 있습니다.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => open()} disabled={approved.length === 0}>
              <ListChecks className="size-4" aria-hidden /> 시험 만들기
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> 새 문제
            </Button>
          </div>
        </div>
      </section>

      {weak.length > 0 && (
        <section aria-labelledby="weak-h" className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
          <h3 id="weak-h" className="font-semibold">
            다시 공부할 주제
          </h3>
          <p className="text-sm text-ink-2">제출한 시험에서 점수를 가장 많이 잃은 주제입니다.</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {weak.slice(0, 6).map((w) => (
              <li key={w.topic} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="truncate">{w.topic}</span>
                <span className="tabular-nums text-bad">
                  {w.percent}% <span className="text-ink-3">({w.earned}/{w.max}점)</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button size="sm" onClick={() => open({ topics: weak.map((w) => w.topic), title: `${course.name}: 약한 주제` })}>
              이 주제 연습하기
            </Button>
          </div>
        </section>
      )}

      {attempts.length > 0 && (
        <section aria-labelledby="hist-h">
          <h3 id="hist-h" className="text-base font-semibold">
            내 시험
          </h3>
          <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
            {attempts.map((a) => {
              const exam = examById.get(a.examId);
              const qs = (exam?.questionIds ?? []).map((id) => byId.get(id)).filter((x): x is QuestionRow => !!x);
              const score = a.status === 'submitted' ? scoreAttempt(qs, a) : undefined;
              return (
                <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{exam?.config.title ?? '시험'}</p>
                    <p className="text-[13px] text-ink-3">
                      {new Date(a.startedAt).toLocaleString('ko-KR')}
                      {a.status === 'in-progress' ? ', 진행 중' : score ? `, ${score.max}점 중 ${score.earned}점(${score.percent}%)${score.complete ? '' : `, 채점할 문제 ${score.pending}개`}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.status === 'in-progress' ? (
                      <Link to={`/exam/${a.id}`} className="inline-flex min-h-9 items-center rounded-[var(--radius-control)] bg-accent px-3 text-sm font-medium text-accent-ink hover:brightness-110">
                        이어서 풀기
                      </Link>
                    ) : (
                      <>
                        <Link to={`/exam/${a.id}/results`} className="inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3 text-sm font-medium hover:bg-sunken">
                          {score && !score.complete ? '채점하고 검토하기' : '검토하기'}
                        </Link>
                        <Button size="sm" variant="ghost" onClick={() => void repeatMissed(a)}>
                          틀린 문제 다시 풀기
                        </Button>
                      </>
                    )}
                    <Menu
                      label={`${exam?.config.title ?? '시험'} 작업`}
                      items={[
                        ...(exam ? [{ label: '인쇄용 시험지', onSelect: () => navigate(`/exam/${exam.id}/paper`) }] : []),
                        { label: '이 응시 삭제', icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => void deleteAttempt(db, a.id) },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="qpend-h" className="rounded-[var(--radius-panel)] border border-warn/40 bg-warn-soft/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 id="qpend-h" className="text-base font-semibold">
                결정을 기다리는 문제 {pending.length}개
              </h3>
              <p className="text-sm text-ink-2">가져온 문제는 승인하기 전까지 시험에 쓰이지 않습니다. 먼저 모범 답안과 출처를 확인하세요.</p>
            </div>
            <Button size="sm" variant="primary" onClick={() => void setQuestionStatus(db, pending.filter((x) => x.sources.every((s) => s.verified !== false)).map((x) => x.id), 'approved')}>
              <Check className="size-4" aria-hidden /> 출처 문제가 없는 문제 모두 승인
            </Button>
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {pending.slice(0, 15).map((x) => (
              <li key={x.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span className="font-medium text-ink-2">{QUESTION_TYPE_LABEL[x.type]}</span>
                  <span>{x.marks}점</span>
                  {x.topic && <span>{x.topic}</span>}
                  <BasisChip basis={x.basis} sources={x.sources} />
                  <SourceStatusChip sources={x.sources} />
                </div>
                <div className="mt-2">
                  <LazyMarkdown>{x.prompt}</LazyMarkdown>
                </div>
                {x.modelAnswer && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-accent">모범 답안과 채점 기준</summary>
                    <div className="mt-2 rounded-[var(--radius-control)] bg-sunken/50 p-3 text-sm">
                      <LazyMarkdown>{x.modelAnswer}</LazyMarkdown>
                      {x.rubric.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-ink-2">
                          {x.rubric.map((r) => (
                            <li key={r.id}>
                              {r.text} ({r.marks}점)
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <SourceList sources={x.sources} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => void setQuestionStatus(db, [x.id], 'approved')}>
                      <Check className="size-4" aria-hidden /> 승인
                    </Button>
                    <Button size="sm" onClick={() => setEditing(x)}>
                      <Pencil className="size-4" aria-hidden /> 편집
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void setQuestionStatus(db, [x.id], 'rejected')}>
                      <X className="size-4" aria-hidden /> 거절
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="bank-h">
        <h3 id="bank-h" className="text-base font-semibold">
          문제 은행({bank.length})
        </h3>
        {bank.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="아직 문제가 없습니다">직접 문제를 쓰거나, 위의 “학습 팩” 메뉴에서 AI로 학습 팩을 만들어 가져오세요. 모든 문제에는 모범 답안, 채점 기준, 출처 슬라이드가 함께 남습니다.</EmptyState>
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <label className="sr-only" htmlFor="qf-q">
                문제 검색
              </label>
              <TextInput id="qf-q" type="search" placeholder="문제 검색" value={text} onChange={(e) => setText(e.target.value)} />
              <label className="sr-only" htmlFor="qf-type">
                종류
              </label>
              <Select id="qf-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">모든 종류</option>
                {QUESTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {QUESTION_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
              <label className="sr-only" htmlFor="qf-status">
                상태
              </label>
              <Select id="qf-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">모든 상태</option>
                <option value="approved">승인됨</option>
                <option value="pending">검토 대기</option>
                <option value="rejected">거절됨</option>
              </Select>
              <label className="sr-only" htmlFor="qf-lec">
                강의
              </label>
              <Select id="qf-lec" value={lectureFilter} onChange={(e) => setLectureFilter(e.target.value)}>
                <option value="">모든 강의</option>
                {lectures.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mt-2 text-sm text-ink-2" aria-live="polite">
              {shown.length}개 표시
            </p>
            <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
              {shown.slice(0, 200).map((x) => (
                <li key={x.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-serif text-[1rem]">{x.prompt.replace(/[*_`$]/g, '')}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span>{QUESTION_TYPE_LABEL[x.type]}</span>
                      <span>{x.marks}점</span>
                      <span>{['', '쉬움', '보통', '어려움'][x.difficulty]}</span>
                      {x.topic && <span>{x.topic}</span>}
                      {x.lectureIds[0] && <span>{lectureTitle(x.lectureIds[0])}</span>}
                      <span>{x.status === 'approved' ? '승인됨' : x.status === 'pending' ? '검토 대기' : '거절됨'}</span>
                      <BasisChip basis={x.basis} sources={x.sources} />
                    </p>
                  </div>
                  <Menu
                    label={`문제 작업: ${x.prompt.slice(0, 40)}`}
                    items={[
                      { label: '편집', icon: <FilePen className="size-4" aria-hidden />, onSelect: () => setEditing(x) },
                      ...(x.status !== 'approved' ? [{ label: '승인', icon: <Check className="size-4" aria-hidden />, onSelect: () => void setQuestionStatus(db, [x.id], 'approved') }] : []),
                      ...(x.status !== 'rejected' ? [{ label: '거절', icon: <X className="size-4" aria-hidden />, onSelect: () => void setQuestionStatus(db, [x.id], 'rejected') }] : []),
                      { label: '삭제', icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => setDeleting([x]) },
                    ]}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <ExamBuilder open={building} onClose={() => setBuilding(false)} course={course} lectures={lectures} bank={bank} attempts={attempts} preset={preset} />
      <QuestionEditor open={creating || !!editing} onClose={() => { setCreating(false); setEditing(undefined); }} courseId={course.id} lectures={lectures} question={editing} />
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title="이 문제를 삭제할까요?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              취소
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                await deleteQuestions(db, deleting.map((d) => d.id));
                toast.show('문제를 삭제했습니다.', 'ok');
                setDeleting(undefined);
              }}
            >
              영구 삭제
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">이 문제를 쓴 지난 시험의 결과는 남지만, 문제 내용은 더 이상 다시 볼 수 없습니다.</p>
      </Dialog>
    </div>
  );
}
