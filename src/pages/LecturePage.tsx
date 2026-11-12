import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, ClipboardCopy, FileText, Search, Sparkles } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { setPictureText } from '@/core/db/library';
import { displayTitle } from '@/core/pptx/topics';
import { recordSlideView } from '@/core/study/progress';
import { useCourse, useLecture, useMediaUrls, useSlides } from '@/app/data';
import { useToast } from '@/app/toast';
import { ChecksView, ExtractedView } from '@/ui/slide/ExtractedView';
import { Filmstrip } from '@/ui/slide/Filmstrip';
import { SlideCanvas } from '@/ui/slide/SlideCanvas';
import { ConfidencePill, IconButton, Select, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();
type Tab = 'content' | 'notes' | 'checks';

export function LecturePage() {
  const { lectureId } = useParams();
  const lecture = useLecture(lectureId);
  const course = useCourse(lecture?.courseId);
  const slides = useSlides(lectureId, lecture?.revision);
  const media = useMediaUrls(lectureId, lecture?.revision);
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('content');
  const [active, setActive] = useState<string | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const [decor, setDecor] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);

  const count = slides?.length ?? 0;
  const current = Math.min(Math.max(1, Number(params.get('slide')) || 1), Math.max(1, count));

  // The slide most recently asked for. Keys can arrive faster than the address updates, and each press must step from the last one.
  const target = useRef(current);
  useEffect(() => {
    target.current = current;
  }, [current]);

  const go = useCallback(
    (n: number) => {
      const next = Math.min(Math.max(1, n), Math.max(1, count));
      target.current = next;
      setParams({ slide: String(next) }, { replace: true });
      setActive(undefined);
    },
    [count, setParams],
  );

  // Remember where the student stopped (dashboard "continue" card).
  useEffect(() => {
    if (!lectureId || !count) return;
    // A tiny write: do it immediately so leaving the page quickly never loses the position.
    void db.settings.put({ key: 'lastViewed', value: { lectureId, slide: current, at: Date.now() } });
  }, [lectureId, current, count]);

  // A slide counts as studied once it has stayed on screen for a few seconds (flicking past does not count).
  useEffect(() => {
    if (!lecture || !count) return;
    const t = window.setTimeout(() => {
      if (!document.hidden) void recordSlideView(db, lecture.courseId, lecture.id, current);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [lecture?.id, lecture?.courseId, current, count]);

  // Keyboard navigation (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(target.current + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(target.current - 1);
      else if (e.key === 'Home') go(1);
      else if (e.key === 'End') go(count);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, go]);

  const slide = slides?.[current - 1];
  const W = lecture?.meta.slideWidth ?? 9144000;
  const H = lecture?.meta.slideHeight ?? 6858000;

  const select = useCallback((id: string | undefined) => {
    setActive(id);
    if (id) {
      setTab('content');
      requestAnimationFrame(() => document.getElementById(`blk-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }, []);

  const topics = lecture?.report.topics ?? [];
  const currentTopic = useMemo(() => topics.find((t) => current >= t.startSlide && current <= t.endSlide), [topics, current]);

  if (lecture === null) return <NotFound what="강의가" />;
  if (!lecture || !slides) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const attn = lecture.report.slidesRequiringAttention.length;
  /** A PDF lecture is read page by page: say "쪽", not "슬라이드". */
  const pdf = lecture.meta.format === 'pdf';
  const noteCount = slide?.notes.trim() ? 1 : 0;
  const flagCount = slide?.flags.filter((f) => f.severity !== 'info' && !f.resolved).length ?? 0;

  const copyText = async () => {
    if (!slide) return;
    try {
      await navigator.clipboard.writeText(`${lecture.title}, 슬라이드 ${slide.index}\n\n${slide.text}${slide.notes ? `\n\n발표자 노트:\n${slide.notes}` : ''}`);
      toast.show('슬라이드 텍스트를 복사했습니다.', 'ok');
    } catch {
      toast.show('브라우저가 복사를 막았습니다. 텍스트를 선택해 직접 복사하세요.', 'error');
    }
  };

  const tabBtn = (id: Tab, label: string, badge?: number) => (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={tab === id}
      aria-controls="tabpanel"
      onClick={() => setTab(id)}
      className={`-mb-px min-h-10 border-b-2 px-3 text-sm font-medium ${tab === id ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}
    >
      {label}
      {badge ? <span className="ml-1.5 rounded-full bg-sunken px-1.5 py-0.5 text-xs text-ink-2">{badge}</span> : null}
    </button>
  );

  return (
    <div className="flex flex-col lg:h-dvh">
      <header className="border-b border-rule bg-surface px-4 py-3 md:px-6">
        <nav aria-label="이동 경로" className="text-[13px] text-ink-3">
          {course && (
            <Link to={`/course/${course.id}`} className="hover:text-ink hover:underline">
              {course.name}
            </Link>
          )}
        </nav>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{lecture.title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <ConfidencePill value={lecture.report.confidenceLabel} />
            <Link to={`/lecture/${lecture.id}/report`} className="inline-flex items-center gap-1.5 text-accent underline underline-offset-2">
              <FileText className="size-4" aria-hidden /> 추출 보고서{attn > 0 ? `(확인할 슬라이드 ${attn}장)` : ''}
            </Link>
            <Link to={`/search?lecture=${lecture.id}`} className="inline-flex items-center gap-1.5 text-accent underline underline-offset-2">
              <Search className="size-4" aria-hidden /> 이 강의에서 검색
            </Link>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)]">
        <aside className="hidden overflow-y-auto border-r border-rule bg-surface p-2 lg:block" aria-label="슬라이드 목록">
          <Filmstrip slides={slides} slideWidth={W} slideHeight={H} media={media} current={current} onSelect={go} orientation="vertical" />
        </aside>

        <div className="min-h-0 min-w-0 lg:overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1.3fr)_minmax(22rem,1fr)] xl:overflow-hidden">
        <section className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-rule" aria-label="슬라이드">
          <div className="border-b border-rule bg-surface px-3 py-2 lg:hidden">
            <Filmstrip slides={slides} slideWidth={W} slideHeight={H} media={media} current={current} onSelect={go} orientation="horizontal" />
          </div>
          <div className="mx-auto w-full max-w-[60rem] p-3 md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
              <div className="flex items-center gap-1">
                <IconButton label={pdf ? '이전 쪽(왼쪽 화살표)' : '이전 슬라이드(왼쪽 화살표)'} onClick={() => go(current - 1)} disabled={current <= 1}>
                  <ChevronLeft className="size-5" aria-hidden />
                </IconButton>
                <p className="min-w-28 text-center text-sm tabular-nums" aria-live="polite">
                  {pdf ? `${current}/${count}쪽` : `슬라이드 ${current}/${count}`}
                </p>
                <IconButton label={pdf ? '다음 쪽(오른쪽 화살표)' : '다음 슬라이드(오른쪽 화살표)'} onClick={() => go(current + 1)} disabled={current >= count}>
                  <ChevronRight className="size-5" aria-hidden />
                </IconButton>
              </div>
              {topics.length > 1 && (
                <div className="min-w-0 max-w-full sm:max-w-72">
                  <label htmlFor="topic-jump" className="sr-only">
                    주제로 이동
                  </label>
                  <Select id="topic-jump" value={currentTopic?.id ?? ''} onChange={(e) => go(topics.find((t) => t.id === e.target.value)?.startSlide ?? 1)} className="min-h-9 text-[13px]">
                    {topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.startSlide === t.endSlide ? t.startSlide : `${t.startSlide}–${t.endSlide}`}: {t.title.slice(0, 60)}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            <div ref={stageRef}>
              {slide ? (
                <SlideCanvas slide={slide} slideWidth={W} slideHeight={H} media={media} showDecor={decor} activeId={active} hoverId={hover} onSelect={select} />
              ) : (
                <p className="text-sm text-ink-2">이 강의에는 슬라이드가 없습니다.</p>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-3">
              <label className="inline-flex min-h-8 items-center gap-2">
                <input type="checkbox" checked={decor} onChange={(e) => setDecor(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                배경 그래픽 보기(로고, 바닥글)
              </label>
              <p>도형을 누르면 추출한 텍스트를 볼 수 있습니다. ← → 키로 슬라이드를 바꿉니다.</p>
            </div>
            {slide?.hidden && <p className="mt-3 rounded bg-sunken px-3 py-2 text-sm text-ink-2">프레젠테이션에서 숨긴 슬라이드입니다.</p>}
          </div>
        </section>

        <section className="min-w-0 border-t border-rule bg-surface xl:min-h-0 xl:overflow-y-auto xl:border-t-0" aria-label="추출한 내용">
          <div className="sticky top-0 z-10 border-b border-rule bg-surface px-4 pt-3 md:px-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 truncate pb-2 text-base font-semibold">
                <span className="text-ink-3">{current}.</span> {slide ? displayTitle(slide) : ''}
              </h2>
              <span className="flex shrink-0 items-center gap-1">
                <Link to={`/course/${lecture.courseId}/tutor?lecture=${lecture.id}&slide=${current}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-sm text-accent hover:bg-sunken">
                  <Sparkles className="size-4" aria-hidden /> 튜터에게 묻기
                </Link>
                <IconButton label="슬라이드 텍스트 복사" onClick={() => void copyText()} className="-mr-2 -mt-1 size-9">
                  <ClipboardCopy className="size-4" aria-hidden />
                </IconButton>
              </span>
            </div>
            <div role="tablist" aria-label="슬라이드 세부 정보" className="flex">
              {tabBtn('content', '내용')}
              {tabBtn('notes', '발표자 노트', noteCount)}
              {tabBtn('checks', '확인 사항', flagCount)}
            </div>
          </div>
          <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="px-2 py-3 md:px-3">
            {slide &&
              (tab === 'content' ? (
                <ExtractedView slide={slide} slideHeight={H} media={media} activeId={active} onActivate={select} onHover={setHover} onSavePictureText={(elementId, text) => setPictureText(db, lecture.id, slide.index, elementId, text)} />
              ) : tab === 'notes' ? (
                <div className="px-3">
                  {slide.notes.trim() ? (
                    <div className="reading whitespace-pre-wrap">{slide.notes}</div>
                  ) : (
                    <p className="text-sm text-ink-2">이 슬라이드에는 발표자 노트가 없습니다.</p>
                  )}
                </div>
              ) : (
                <div className="px-3">
                  <ChecksView slide={slide} />
                </div>
              ))}
          </div>
        </section>
        </div>
      </div>
    </div>
  );
}
