import { useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { Check, FilePen, Pencil, Plus, Play, Trash2, WandSparkles, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import { draftCardsFromLecture } from '@/core/study/drafts';
import { intervalLabel } from '@/core/study/fsrs';
import { buildQueue, cardStats } from '@/core/study/queue';
import { createCard, deleteCards, setCardStatus } from '@/core/study/store';
import { CARD_TYPES, CARD_TYPE_LABEL, type CardRow, type ReviewStatus } from '@/core/study/types';
import { useCards, useReviews, useSetting } from '@/app/data';
import { useToast } from '@/app/toast';
import { Menu } from '@/ui/Menu';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { CardEditor } from '@/ui/study/CardEditor';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Dialog, EmptyState, Select, Spinner, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';

const db = getDb();
const DEFAULT_NEW_PER_DAY = 15;

function stateLabel(c: CardRow, now: number): string {
  const s = c.fsrs;
  if (s.state === 0) return '새 카드';
  const wait = s.due - now;
  if (wait <= 0) return '지금 복습';
  return `${s.state === 2 ? '복습' : '학습 중'}, ${intervalLabel(wait)} 뒤 복습`;
}

export function CardsPage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const cards = useCards(course.id);
  const reviews = useReviews(course.id);
  const [newPerDay, setNewPerDay] = useSetting<number>('newCardsPerDay');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'all') as ReviewStatus | 'all';
  const [lectureFilter, setLectureFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<CardRow | undefined>();
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [deleting, setDeleting] = useState<CardRow[] | undefined>();
  const now = Date.now();
  const perDay = newPerDay ?? DEFAULT_NEW_PER_DAY;

  const stats = useMemo(() => (cards && reviews ? cardStats(cards, reviews, now) : undefined), [cards, reviews, now]);
  const queue = useMemo(() => (cards && stats ? buildQueue(cards, { now, newPerDay: perDay, newToday: stats.newToday }) : []), [cards, stats, now, perDay]);

  if (!cards || !reviews || !stats) {
    return <Spinner />;
  }

  const pending = cards.filter((c) => c.status === 'pending');
  const lectureTitle = (id?: string) => lectures.find((l) => l.id === id)?.title;
  const q = text.trim().toLowerCase();
  const shown = cards
    .filter((c) => (status === 'all' ? true : c.status === status))
    .filter((c) => !lectureFilter || c.lectureId === lectureFilter)
    .filter((c) => !typeFilter || c.type === typeFilter)
    .filter((c) => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt);

  const setStatus = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.delete('status');
    else next.set('status', v);
    setParams(next, { replace: true });
  };

  const statTile = (label: string, value: number | string, hint?: string) => (
    <div className="bg-surface px-4 py-3">
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-ink-3">{hint}</dd>}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="study-h">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="study-h" className="text-lg font-semibold">
              지금 공부하기
            </h2>
            <p className="text-sm text-ink-2">
              {queue.length > 0 ? `카드 ${queue.length}장 준비됨: 복습할 카드 ${stats.dueNow}장과 새 카드 최대 ${Math.max(0, perDay - stats.newToday)}장.` : stats.approved === 0 ? '아직 승인한 카드가 없습니다.' : '지금 복습할 카드가 없습니다.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 whitespace-nowrap text-[13px] text-ink-2">
              하루 새 카드 수
              <Select value={String(perDay)} onChange={(e) => void setNewPerDay(Number(e.target.value))} className="min-h-9 w-20 text-[13px]">
                {[5, 10, 15, 20, 30, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            {queue.length > 0 ? (
              <Link to={`/course/${course.id}/review`} className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-medium text-accent-ink hover:brightness-110">
                <Play className="size-4" aria-hidden /> 복습 시작
              </Link>
            ) : (
              <Button variant="primary" disabled>
                <Play className="size-4" aria-hidden /> 복습 시작
              </Button>
            )}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-4 lg:grid-cols-7">
          {statTile('지금 복습', stats.dueNow)}
          {statTile('새 카드', stats.newCards)}
          {statTile('학습 중', stats.learning)}
          {statTile('복습', stats.review)}
          {statTile('어려운 카드', stats.difficult)}
          {statTile('오늘 복습', stats.reviewedToday)}
          {statTile('정답률', stats.accuracy30d === undefined ? '기록 없음' : `${Math.round(stats.accuracy30d * 100)}%`, stats.reviews30d ? `최근 30일, 복습 ${stats.reviews30d}회` : undefined)}
        </dl>
      </section>

      {pending.length > 0 && (
        <section aria-labelledby="pending-h" className="rounded-[var(--radius-panel)] border border-warn/40 bg-warn-soft/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="pending-h" className="text-lg font-semibold">
                결정을 기다리는 카드 {pending.length}장
              </h2>
              <p className="text-sm text-ink-2">학습 팩과 슬라이드 스캐너로 만든 카드는 승인하기 전까지 학습에 쓰이지 않습니다. 확실하지 않은 카드는 출처를 확인하세요.</p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  await setCardStatus(db, pending.filter((c) => c.sources.every((s) => s.verified !== false)).map((c) => c.id), 'approved');
                  toast.show('인용문이 슬라이드와 어긋나지 않는 대기 카드를 모두 승인했습니다.', 'ok');
                }}
              >
                <Check className="size-4" aria-hidden /> 출처 문제가 없는 카드 모두 승인
              </Button>
            </div>
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {pending.slice(0, 20).map((c) => (
              <li key={c.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span className="font-medium text-ink-2">{CARD_TYPE_LABEL[c.type]}</span>
                  {lectureTitle(c.lectureId) && <span>{lectureTitle(c.lectureId)}</span>}
                  <BasisChip basis={c.basis} sources={c.sources} />
                  <SourceStatusChip sources={c.sources} />
                  {c.origin === 'auto' && <span className="rounded bg-sunken px-1.5">자동 추출, 확인 필요</span>}
                </div>
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-ink-3">앞면</p>
                    <LazyMarkdown>{c.front}</LazyMarkdown>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-ink-3">뒷면</p>
                    <LazyMarkdown>{c.back}</LazyMarkdown>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <SourceList sources={c.sources} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => void setCardStatus(db, [c.id], 'approved')}>
                      <Check className="size-4" aria-hidden /> 승인
                    </Button>
                    <Button size="sm" onClick={() => setEditing(c)}>
                      <Pencil className="size-4" aria-hidden /> 편집
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void setCardStatus(db, [c.id], 'rejected')}>
                      <X className="size-4" aria-hidden /> 거절
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {pending.length > 20 && <p className="mt-2 text-sm text-ink-2">처음 20장만 보입니다. 이 카드들을 승인하거나 거절하면 나머지가 나타납니다.</p>}
        </section>
      )}

      <section aria-labelledby="all-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="all-h" className="text-lg font-semibold">
            모든 카드({cards.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> 새 카드
            </Button>
            <Button size="sm" onClick={() => setDrafting(true)} disabled={lectures.length === 0}>
              <WandSparkles className="size-4" aria-hidden /> 슬라이드에서 초안 만들기
            </Button>
          </div>
        </div>

        {cards.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="아직 플래시카드가 없습니다">
              직접 카드를 추가하거나, 앱이 슬라이드에서 초안을 만들게 하거나(AI 필요 없음), 위의 “학습 팩” 메뉴에서 다른 AI로 만든 학습 팩을 가져오세요.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <label className="sr-only" htmlFor="cf-q">
                카드 검색
              </label>
              <TextInput id="cf-q" type="search" placeholder="카드 검색" value={text} onChange={(e) => setText(e.target.value)} />
              <label className="sr-only" htmlFor="cf-status">
                상태
              </label>
              <Select id="cf-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">모든 상태</option>
                <option value="approved">승인됨</option>
                <option value="pending">검토 대기</option>
                <option value="rejected">거절됨</option>
              </Select>
              <label className="sr-only" htmlFor="cf-lecture">
                강의
              </label>
              <Select id="cf-lecture" value={lectureFilter} onChange={(e) => setLectureFilter(e.target.value)}>
                <option value="">모든 강의</option>
                {lectures.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </Select>
              <label className="sr-only" htmlFor="cf-type">
                종류
              </label>
              <Select id="cf-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">모든 종류</option>
                {CARD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CARD_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mt-2 text-sm text-ink-2" aria-live="polite">
              {shown.length}장 표시
              {status === 'rejected' && shown.length > 0 && (
                <>
                  {' '}
                  <button type="button" className="text-bad underline underline-offset-2" onClick={() => setDeleting(shown)}>
                    이 {shown.length}장 삭제
                  </button>
                </>
              )}
            </p>
            <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
              {shown.slice(0, 200).map((c) => (
                <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-serif text-[1rem]">{c.front.replace(/[*_`$]/g, '')}</p>
                    <p className="mt-0.5 line-clamp-1 text-sm text-ink-2">{c.back.replace(/[*_`$]/g, '')}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span>{CARD_TYPE_LABEL[c.type]}</span>
                      {lectureTitle(c.lectureId) && <span>{lectureTitle(c.lectureId)}</span>}
                      <span>{c.status === 'approved' ? stateLabel(c, now) : c.status === 'pending' ? '검토 대기' : '거절됨'}</span>
                      {c.fsrs.lapses > 0 && <span>잊음 {c.fsrs.lapses}회</span>}
                      <BasisChip basis={c.basis} sources={c.sources} />
                    </p>
                  </div>
                  <Menu
                    label={`카드 작업: ${c.front.slice(0, 40)}`}
                    items={[
                      { label: '편집', icon: <FilePen className="size-4" aria-hidden />, onSelect: () => setEditing(c) },
                      ...(c.status !== 'approved' ? [{ label: '승인', icon: <Check className="size-4" aria-hidden />, onSelect: () => void setCardStatus(db, [c.id], 'approved') }] : []),
                      ...(c.status !== 'rejected' ? [{ label: '거절', icon: <X className="size-4" aria-hidden />, onSelect: () => void setCardStatus(db, [c.id], 'rejected') }] : []),
                      { label: '삭제', icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => setDeleting([c]) },
                    ]}
                  />
                </li>
              ))}
            </ul>
            {shown.length > 200 && <p className="mt-2 text-sm text-ink-2">최근 200장만 보입니다. 필터로 목록을 좁히세요.</p>}
          </>
        )}
      </section>

      <CardEditor open={creating || !!editing} onClose={() => { setCreating(false); setEditing(undefined); }} courseId={course.id} lectures={lectures} card={editing} />

      <DraftDialog open={drafting} onClose={() => setDrafting(false)} courseId={course.id} lectures={lectures} existing={cards} />

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title={`카드 ${deleting?.length ?? 0}장을 삭제할까요?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              취소
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                await deleteCards(db, deleting.map((c) => c.id));
                toast.show('삭제했습니다.', 'ok');
                setDeleting(undefined);
              }}
            >
              영구 삭제
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">카드와 복습 기록이 이 기기에서 지워집니다. 되돌릴 수 없습니다.</p>
      </Dialog>
    </div>
  );
}

function DraftDialog({ open, onClose, courseId, lectures, existing }: { open: boolean; onClose: () => void; courseId: string; lectures: import('@/core/db/db').LectureRow[]; existing: CardRow[] }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    setPicked(new Set(lectures.map((l) => l.id)));
  }
  if (!open && seen) setSeen(false);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="슬라이드로 카드 초안 만들기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={picked.size === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const have = new Set(existing.map((c) => `${c.front}\u0000${c.back}`));
                let added = 0;
                for (const l of lectures.filter((x) => picked.has(x.id))) {
                  const { cards } = draftCardsFromLecture(l, await loadSlides(db, l.id));
                  const base = Date.now();
                  for (const [i, card] of cards.entries()) {
                    if (have.has(`${card.front}\u0000${card.back}`)) continue;
                    await createCard(db, { ...card, courseId }, base + i);
                    added += 1;
                  }
                }
                toast.show(added ? `검토할 초안 카드 ${added}장을 추가했습니다.` : '새로 찾은 것이 없습니다. 스캐너는 “굵은 용어: 설명” 형식의 줄과 표만 알아봅니다.', added ? 'ok' : 'info');
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            슬라이드 스캔
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-ink-2">
          AI가 아닌 간단한 규칙 기반 스캐너입니다. 굵은 용어 뒤에 설명이 오는 줄(예: “<strong>결정 가능 언어</strong>: 어떤 튜링 기계가…”)과 표를 찾습니다. 초안은 승인하기 전까지 학습에 쓰이지 않습니다.
        </p>
        <ul className="max-h-52 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
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
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{l.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
