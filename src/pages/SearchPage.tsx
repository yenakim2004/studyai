import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Search as SearchIcon, StickyNote } from 'lucide-react';
import { useAllLectures, useCourses, useSearch } from '@/app/data';
import { EmptyState, Select, Spinner, TextInput } from '@/ui/primitives';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const courseId = params.get('course') ?? '';
  const lectureId = params.get('lecture') ?? '';
  const courses = useCourses();
  const lectures = useAllLectures();
  const { ready, version, search } = useSearch();
  const [text, setText] = useState(urlQuery);

  // Keep the box in sync when the URL changes from elsewhere (sidebar search).
  useEffect(() => setText(urlQuery), [urlQuery]);

  // Debounced URL update while typing.
  useEffect(() => {
    if (text === urlQuery) return;
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (text.trim()) next.set('q', text);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 180);
    return () => window.clearTimeout(t);
  }, [text, urlQuery, params, setParams]);

  const hits = useMemo(() => (urlQuery.trim() ? search(urlQuery, { courseId: courseId || undefined, lectureId: lectureId || undefined }, 60) : []), [urlQuery, courseId, lectureId, search, version]);
  const scopedLecture = lectures?.find((l) => l.id === lectureId);

  const setFilter = (key: 'course' | 'lecture', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'course') next.delete('lecture');
    setParams(next, { replace: true });
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">검색</h1>
      <p className="mt-1 text-sm text-ink-2">슬라이드 텍스트, 표, 차트와 도식의 텍스트, 그림 설명, 발표자 노트를 검색합니다.</p>

      <form role="search" onSubmit={(e) => e.preventDefault()} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <label htmlFor="q" className="sr-only">
            검색어
          </label>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <TextInput id="q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="예: 정지 문제 환원" className="pl-9" autoFocus />
        </div>
        <div>
          <label htmlFor="course-filter" className="sr-only">
            과목으로 좁히기
          </label>
          <Select id="course-filter" value={courseId} onChange={(e) => setFilter('course', e.target.value)} className="sm:w-56">
            <option value="">모든 과목</option>
            {courses?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </form>
      {scopedLecture && (
        <p className="mt-2 text-sm text-ink-2">
          “{scopedLecture.title}”에서만 찾는 중입니다.{' '}
          <button type="button" className="text-accent underline underline-offset-2" onClick={() => setFilter('lecture', '')}>
            전체에서 검색
          </button>
        </p>
      )}

      <div className="mt-6" aria-live="polite">
        {!ready ? (
          <Spinner label="검색 준비 중" />
        ) : !urlQuery.trim() ? (
          <EmptyState title="강의를 검색하려면 입력하세요">결과마다 해당 슬라이드로 바로 연결되어 출처를 확인할 수 있습니다.</EmptyState>
        ) : hits.length === 0 ? (
          <EmptyState title={`“${urlQuery}”와(과) 일치하는 슬라이드가 없습니다`}>검색어를 줄이거나 바꿔 보세요. 그림 안에만 있는 글자는 검색할 수 없습니다.</EmptyState>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              슬라이드 {hits.length}
              {hits.length === 60 ? '+' : ''}장
            </p>
            <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
              {hits.map((h) => (
                <li key={h.id}>
                  <Link to={`/lecture/${h.lectureId}?slide=${h.slide}`} className="block px-4 py-3 hover:bg-sunken">
                    <span className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-3">
                      <span>{h.courseName}</span>
                      <span aria-hidden>/</span>
                      <span>{h.lectureTitle}</span>
                      <span aria-hidden>/</span>
                      <span className="tabular-nums">슬라이드 {h.slide}</span>
                    </span>
                    <span className="mt-0.5 block font-medium">{h.title}</span>
                    <span className="mt-1 block font-serif text-[0.95rem] leading-relaxed text-ink-2">
                      {h.inNotes && (
                        <span className="mr-1.5 inline-flex items-center gap-1 rounded bg-sunken px-1.5 text-xs font-sans text-ink-2">
                          <StickyNote className="size-3" aria-hidden /> 발표자 노트
                        </span>
                      )}
                      {h.snippet.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
