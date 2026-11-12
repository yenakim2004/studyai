import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { getDb, type CourseRow, type LectureRow } from '@/core/db/db';
import { filterBank, selectQuestions, weakTopics } from '@/core/study/exam';
import { createExam, startAttempt } from '@/core/study/attempts';
import { QUESTION_TYPES, QUESTION_TYPE_LABEL, type AttemptRow, type ExamConfig, type QuestionRow, type QuestionType } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { Button, Callout, Dialog, Field, Select, TextInput } from '@/ui/primitives';

const db = getDb();

/** Configure an exam from the question bank. Nothing is invented: only approved questions are used. */
export function ExamBuilder({ open, onClose, course, lectures, bank, attempts, preset }: { open: boolean; onClose: () => void; course: CourseRow; lectures: LectureRow[]; bank: QuestionRow[]; attempts: AttemptRow[]; preset?: Partial<ExamConfig> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [lectureIds, setLectureIds] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState<'mixed' | 1 | 2 | 3>('mixed');
  const [totalMarks, setTotalMarks] = useState('');
  const [minutes, setMinutes] = useState('');
  const [hints, setHints] = useState(true);
  const [reveal, setReveal] = useState<'immediate' | 'after'>('after');
  const [layout, setLayout] = useState<'one' | 'paper'>('one');
  const [conditions, setConditions] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(preset?.title ?? `${course.name} 연습, ${new Date().toLocaleDateString('ko-KR')}`);
    setLectureIds(preset?.lectureIds ?? []);
    setTopics(preset?.topics ?? []);
    setTypes(preset?.types ?? []);
    setCount(preset?.count ?? 10);
    setDifficulty(preset?.difficulty ?? 'mixed');
    setTotalMarks(preset?.totalMarks ? String(preset.totalMarks) : '');
    setMinutes(preset?.minutes ? String(preset.minutes) : '');
    setHints(preset?.hints ?? true);
    setReveal(preset?.reveal ?? 'after');
    setLayout(preset?.layout ?? 'one');
    setConditions(preset?.conditions ?? false);
  }, [open, course.name, preset]);

  const allTopics = useMemo(() => [...new Set(bank.filter((q) => q.status === 'approved' && q.topic).map((q) => q.topic!))].sort(), [bank]);
  const weak = useMemo(() => weakTopics(attempts, new Map(bank.map((q) => [q.id, q])), 2, 60), [attempts, bank]);
  const config: ExamConfig = {
    title: title.trim() || '모의시험',
    lectureIds,
    topics,
    count: Math.max(1, Math.min(200, Math.round(count) || 1)),
    types,
    difficulty,
    ...(totalMarks && Number(totalMarks) > 0 ? { totalMarks: Number(totalMarks) } : {}),
    ...(minutes && Number(minutes) > 0 ? { minutes: Number(minutes) } : {}),
    hints: conditions ? false : hints,
    reveal: conditions ? 'after' : reveal,
    layout,
    conditions,
  };
  const matching = filterBank(bank, config).length;
  const typeCounts = useMemo(() => {
    const m = new Map<QuestionType, number>();
    for (const q of filterBank(bank, { ...config, types: [] })) m.set(q.type, (m.get(q.type) ?? 0) + 1);
    return m;
  }, [bank, lectureIds, topics, difficulty]);

  const make = async (go: 'take' | 'paper') => {
    setBusy(true);
    try {
      const sel = selectQuestions(bank, config);
      if (sel.ids.length === 0) {
        toast.show('이 설정에 맞는 승인된 문제가 없습니다. 조건을 넓히거나 문제를 추가하세요.', 'error');
        return;
      }
      const exam = await createExam(db, course.id, config, sel.ids);
      onClose();
      if (sel.notes.length > 0) toast.show(sel.notes.join(' '), 'info');
      if (go === 'paper') navigate(`/exam/${exam.id}/paper`);
      else navigate(`/exam/${(await startAttempt(db, exam.id)).id}`);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '시험을 만들지 못했습니다.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="모의시험 만들기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button disabled={busy || matching === 0} onClick={() => void make('paper')}>
            인쇄용 시험지
          </Button>
          <Button variant="primary" disabled={busy || matching === 0} onClick={() => void make('take')}>
            시험 시작
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        {course.examStyle?.trim() ? (
          <Callout tone="info" title="교수의 출제 스타일(이 과목에 저장됨)">
            {course.examStyle.trim()}
            <p className="mt-1 text-[13px] text-ink-3">연습 문제는 문제 은행에 있는 문제만큼만 이 스타일에 가깝습니다. 연습은 학습 내용을 대표할 뿐 실제 시험을 예측하지 않습니다.</p>
          </Callout>
        ) : (
          <p className="text-ink-3">팁: 과목 정보에 교수의 출제 안내를 저장하면 그 스타일로 문제를 유지할 수 있습니다. 연습은 학습 내용을 대표할 뿐 실제 시험을 예측하지 않습니다.</p>
        )}

        <Field label="시험 이름" htmlFor="x-title">
          <TextInput id="x-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <fieldset>
          <legend className="mb-1 font-medium">포함할 강의</legend>
          <ul className="max-h-36 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
            {lectures.map((l) => (
              <li key={l.id}>
                <label className="flex min-h-9 cursor-pointer items-center gap-2.5 px-3 hover:bg-sunken">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={lectureIds.includes(l.id)} onChange={() => setLectureIds(toggle(lectureIds, l.id))} />
                  <span className="truncate">{l.title}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[13px] text-ink-3">{lectureIds.length === 0 ? '하나도 고르지 않으면 모든 강의를 씁니다.' : `${lectureIds.length}개 선택함.`}</p>
        </fieldset>

        {allTopics.length > 0 && (
          <fieldset>
            <legend className="mb-1 font-medium">주제</legend>
            <div className="flex flex-wrap gap-2">
              {allTopics.map((t) => (
                <label key={t} className={`inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${topics.includes(t) ? 'border-accent bg-accent-soft text-ink' : 'border-rule-strong text-ink-2 hover:bg-sunken'}`}>
                  <input type="checkbox" className="sr-only" checked={topics.includes(t)} onChange={() => setTopics(toggle(topics, t))} />
                  {t}
                </label>
              ))}
            </div>
            {weak.length > 0 && (
              <p className="mt-2 text-[13px]">
                <button type="button" className="text-accent underline underline-offset-2" onClick={() => setTopics(weak.map((w) => w.topic))}>
                  약한 주제에 집중
                </button>{' '}
                <span className="text-ink-3">({weak.map((w) => `${w.topic} ${w.percent}%`).join(', ')})</span>
              </p>
            )}
          </fieldset>
        )}

        <fieldset>
          <legend className="mb-1 font-medium">문제 유형</legend>
          <div className="flex flex-wrap gap-2">
            {QUESTION_TYPES.map((t) => {
              const n = typeCounts.get(t) ?? 0;
              return (
                <label key={t} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${n === 0 ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'} ${types.includes(t) ? 'border-accent bg-accent-soft text-ink' : 'border-rule-strong text-ink-2 hover:bg-sunken'}`}>
                  <input type="checkbox" className="sr-only" disabled={n === 0} checked={types.includes(t)} onChange={() => setTypes(toggle(types, t))} />
                  {QUESTION_TYPE_LABEL[t]} <span className="ml-1.5 text-ink-3">{n}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[13px] text-ink-3">하나도 고르지 않으면 문제가 있는 모든 유형을 씁니다.</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="문제 수" htmlFor="x-count">
            <TextInput id="x-count" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </Field>
          <Field label="난이도" htmlFor="x-diff">
            <Select id="x-diff" value={String(difficulty)} onChange={(e) => setDifficulty(e.target.value === 'mixed' ? 'mixed' : (Number(e.target.value) as 1 | 2 | 3))}>
              <option value="mixed">섞어서</option>
              <option value="1">쉬움</option>
              <option value="2">보통</option>
              <option value="3">어려움</option>
            </Select>
          </Field>
          <Field label="총점(선택)" htmlFor="x-marks">
            <TextInput id="x-marks" type="number" min={1} value={totalMarks} onChange={(e) => setTotalMarks(e.target.value)} placeholder="예: 50" />
          </Field>
          <Field label="제한 시간, 분(선택)" htmlFor="x-min">
            <TextInput id="x-min" type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="예: 90" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 font-medium">화면 구성</legend>
            {(
              [
                ['one', '한 번에 한 문제씩'],
                ['paper', '한 페이지에 전체 시험지'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex min-h-9 items-center gap-2.5">
                <input type="radio" name="layout" className="accent-[var(--accent)]" checked={layout === v} onChange={() => setLayout(v)} /> {label}
              </label>
            ))}
          </fieldset>
          <fieldset disabled={conditions}>
            <legend className="mb-1 font-medium">답과 힌트</legend>
            <label className="flex min-h-9 items-center gap-2.5">
              <input type="radio" name="reveal" className="accent-[var(--accent)]" checked={(conditions ? 'after' : reveal) === 'after'} onChange={() => setReveal('after')} /> 제출한 뒤 답 보기
            </label>
            <label className="flex min-h-9 items-center gap-2.5">
              <input type="radio" name="reveal" className="accent-[var(--accent)]" checked={!conditions && reveal === 'immediate'} onChange={() => setReveal('immediate')} /> 문제마다 답 보기
            </label>
            <label className="flex min-h-9 items-center gap-2.5">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={conditions ? false : hints} onChange={(e) => setHints(e.target.checked)} /> 힌트 허용
            </label>
          </fieldset>
        </div>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={conditions} onChange={(e) => setConditions(e.target.checked)} />
          <span>
            <span className="font-medium">시험 조건</span>
            <span className="block text-ink-3">힌트를 쓸 수 없고, 제출하기 전에는 답을 볼 수 없으며, 페이지를 떠나도 시간은 계속 흐릅니다.</span>
          </span>
        </label>

        <p className="rounded bg-sunken px-3 py-2" aria-live="polite">
          {matching === 0 ? '이 설정에 맞는 승인된 문제가 없습니다.' : `승인된 문제 ${matching}개가 맞고, 그중 ${Math.min(config.count, matching)}개를 씁니다.`}
        </p>
      </div>
    </Dialog>
  );
}
