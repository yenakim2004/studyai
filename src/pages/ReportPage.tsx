import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { displayTitle } from '@/core/pptx/topics';
import { topicProgress } from '@/core/study/progress';
import { useCourse, useLecture, useSlides, useViewed } from '@/app/data';
import { ConfidencePill, formatBytes, SeverityIcon, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

type Filter = 'all' | 'check' | 'attention';

const SOURCE_LABEL = { section: 'PowerPoint 구역', layout: '구역 머리글 슬라이드', title: '슬라이드 제목' } as const;

export function ReportPage() {
  const { lectureId } = useParams();
  const lecture = useLecture(lectureId);
  const course = useCourse(lecture?.courseId);
  const slides = useSlides(lectureId, lecture?.revision);
  const [filter, setFilter] = useState<Filter>('check');
  const viewed = useViewed(lectureId);

  if (lecture === null) return <NotFound what="강의가" />;
  if (!lecture || !slides) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  const r = lecture.report;
  const shown = slides.filter((s) => (filter === 'all' ? true : filter === 'attention' ? s.confidence === 'low' : s.confidence !== 'high'));
  const stats: [string, number][] = [
    ['슬라이드', r.totalSlides],
    ['제대로 읽음', r.processedSlides],
    ['주의 필요', r.slidesRequiringAttention.length],
    ['표', r.tables],
    ['그림', r.pictures],
    ['차트', r.charts],
    ['도식(SmartArt)', r.smartArt],
    ['수식', r.equations],
    ['포함 개체', r.oleObjects],
    ['발표자 노트 있음', r.slidesWithNotes],
    ['숨긴 슬라이드', r.hiddenSlides.length],
    ['찾은 주제', r.topics.length],
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <nav aria-label="이동 경로" className="text-[13px] text-ink-3">
        {course && (
          <>
            <Link to={`/course/${course.id}`} className="hover:underline">
              {course.name}
            </Link>
            {' / '}
          </>
        )}
        <Link to={`/lecture/${lecture.id}`} className="hover:underline">
          {lecture.title}
        </Link>
      </nav>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">추출 보고서</h1>
        <ConfidencePill value={r.confidenceLabel} />
        <span className="text-sm text-ink-2">전체 {Math.round(r.overallConfidence * 100)}%</span>
      </div>
      <p className="mt-2 max-w-prose text-sm text-ink-2">
        <span className="font-medium text-ink">{lecture.fileName}</span>에서 읽은 것과 빠졌을 수 있는 것입니다. 추출한 텍스트는 파일과 대조합니다. 슬라이드의 모든 텍스트는 추출되거나 여기에 표시되어야 합니다.
      </p>

      <section className="mt-6" aria-labelledby="stats-h">
        <h2 id="stats-h" className="sr-only">
          개수
        </h2>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-3 md:grid-cols-4">
          {stats.map(([k, v]) => (
            <div key={k} className="bg-surface px-4 py-3">
              <dt className="text-[13px] text-ink-3">{k}</dt>
              <dd className={`text-xl font-semibold tabular-nums ${k === '주의 필요' && v > 0 ? 'text-bad' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-8" aria-labelledby="missing-h">
        <h2 id="missing-h" className="text-lg font-semibold">
          빠졌을 수 있는 내용
        </h2>
        {r.potentiallyMissing.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">표시된 문제가 없습니다. 그래도 그림 속 텍스트는 읽지 않으니 스크린샷이 있는 슬라이드는 직접 확인하세요.</p>
        ) : (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
            {r.potentiallyMissing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="slides-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="slides-h" className="text-lg font-semibold">
            슬라이드
          </h2>
          <div role="group" aria-label="슬라이드 필터" className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-rule-strong text-sm">
            {(
              [
                ['check', '확인할 슬라이드'],
                ['attention', '주의 필요'],
                ['all', '전체'],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`min-h-9 px-3 ${filter === id ? 'bg-accent-soft font-medium text-ink' : 'bg-surface text-ink-2 hover:bg-sunken'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">이 필터에 해당하는 슬라이드가 없습니다.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
            {shown.map((s) => (
              <li key={s.index} className="grid gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[3rem_minmax(0,1fr)_9rem]">
                <Link to={`/lecture/${lecture.id}?slide=${s.index}`} className="text-sm tabular-nums text-accent underline underline-offset-2">
                  {s.index}
                </Link>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayTitle(s)}</p>
                  {s.flags
                    .filter((f) => f.severity !== 'info')
                    .map((f, i) => (
                      <p key={i} className="mt-1 flex items-start gap-1.5 text-[13px] text-ink-2">
                        <span className="mt-0.5 shrink-0">
                          <SeverityIcon severity={f.severity} />
                        </span>
                        {f.message}
                      </p>
                    ))}
                </div>
                <div className="md:text-right">
                  <ConfidencePill value={s.confidence} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="topics-h">
        <h2 id="topics-h" className="text-lg font-semibold">
          찾은 주제
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          {r.topics[0] ? SOURCE_LABEL[r.topics[0].source] : '슬라이드 제목'}을 기준으로 묶었습니다. 내용을 해석한 것이 아니라 있는 슬라이드의 범위입니다.
        </p>
        <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
          {(lecture ? topicProgress(lecture, viewed) : []).map((p) => ({ p, t: r.topics.find((x) => x.id === p.id)! })).map(({ p, t }) => (
            <li key={t.id} className="grid gap-x-4 px-4 py-2.5 text-sm md:grid-cols-[6rem_minmax(0,1fr)]">
              <Link to={`/lecture/${lecture.id}?slide=${t.startSlide}`} className="tabular-nums text-accent underline underline-offset-2">
                {t.startSlide === t.endSlide ? `슬라이드 ${t.startSlide}` : `슬라이드 ${t.startSlide}–${t.endSlide}`}
              </Link>
              <div className="min-w-0">
                <p className="truncate font-medium">{t.title}</p>
                <p className="text-[13px] text-ink-3">{p.done ? '학습 완료: 모든 슬라이드를 봄' : p.viewed === 0 ? '아직 공부하지 않음' : `${p.total}장 중 ${p.viewed}장 학습`}</p>
                {t.keyTerms.filter((k) => k.toLowerCase() !== t.title.toLowerCase()).length > 0 && (
                  <p className="truncate text-[13px] text-ink-3">{t.keyTerms.filter((k) => k.toLowerCase() !== t.title.toLowerCase()).join(', ')}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-labelledby="limits-h">
        <details>
          <summary id="limits-h" className="cursor-pointer text-lg font-semibold">
            알려진 한계
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {r.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      </section>

      <section className="mt-8 border-t border-rule pt-4 text-[13px] text-ink-3" aria-label="원본 파일">
        <p>
          {lecture.fileName}, {formatBytes(lecture.fileSize)}, SHA-256 <span className="font-mono">{lecture.fileHash.slice(0, 12)}…</span>. 가져온 날짜 {new Date(lecture.importedAt).toLocaleString('ko-KR')}
          {lecture.revision > 1 ? `, ${lecture.revision - 1}번 교체함` : ''}.
          {lecture.meta.author ? ` 작성자: ${lecture.meta.author}.` : ''}
        </p>
      </section>
    </div>
  );
}
