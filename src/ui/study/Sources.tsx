import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { BASIS_LABEL, type Basis, type SourceRefRow } from '@/core/study/types';
import { sourceStatus } from '@/core/study/pack';
import { useAllLectures } from '@/app/data';

/**
 * "On the slides / Derived / Outside knowledge / Uncertain": the four-way provenance of an item.
 * A claim of "on the slides" that the app could not verify is shown as such, never as a trusted green chip.
 */
export function BasisChip({ basis, sources }: { basis: Basis; sources?: SourceRefRow[] }) {
  if (basis === 'lecture' && sources && sourceStatus(sources) !== 'verified') {
    const contradicted = sourceStatus(sources) === 'unverified';
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${contradicted ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn'}`} title="이 항목은 슬라이드에서 왔다고 하지만 앱이 확인하지 못했습니다.">
        {contradicted ? '슬라이드에 있다고 함, 확인 안 됨' : '슬라이드에 있음(확인 안 함)'}
      </span>
    );
  }
  const cls = { lecture: 'bg-ok-soft text-ok', derived: 'bg-accent-soft text-ink', outside: 'bg-warn-soft text-warn', uncertain: 'bg-bad-soft text-bad' }[basis];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{BASIS_LABEL[basis]}</span>;
}

/** Whether the item's cited quotes were found on the cited slides. Never colour-only. */
export function SourceStatusChip({ sources }: { sources: SourceRefRow[] }) {
  const s = sourceStatus(sources);
  const map = {
    verified: { Icon: CircleCheck, text: '출처 확인됨', cls: 'text-ok' },
    'slide-only': { Icon: CircleHelp, text: '슬라이드만 인용, 인용문 확인 안 함', cls: 'text-ink-2' },
    unverified: { Icon: TriangleAlert, text: '슬라이드에서 인용문을 찾지 못함', cls: 'text-bad' },
    none: { Icon: CircleHelp, text: '인용한 출처 없음', cls: 'text-ink-3' },
  }[s];
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${map.cls}`}>
      <map.Icon className="size-3.5" aria-hidden /> {map.text}
    </span>
  );
}

/** Links to the cited slides ("Show source"), with the quote. Warns when the lecture has since been replaced. */
export function SourceList({ sources }: { sources: SourceRefRow[] }) {
  const lectures = useAllLectures();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="text-sm">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-accent underline underline-offset-2">
        {open ? '출처 숨기기' : `출처 보기(${sources.length})`}
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-2">
          {sources.map((s, i) => {
            const lec = lectures?.find((l) => l.id === s.lectureId);
            return (
              <li key={i} className="rounded-[var(--radius-control)] border border-rule bg-sunken/50 px-3 py-2">
                {lec ? (
                  <Link to={`/lecture/${lec.id}?slide=${s.slide}`} className="font-medium text-accent underline underline-offset-2">
                    {lec.title}, 슬라이드 {s.slide}
                  </Link>
                ) : (
                  <span className="text-ink-3">라이브러리에 더 이상 없는 강의(슬라이드 {s.slide})</span>
                )}
                {lec && s.rev !== undefined && s.rev !== lec.revision && <p className="mt-1 text-[13px] text-warn">이 항목을 만든 뒤 강의가 교체되어 슬라이드 번호가 바뀌었을 수 있습니다.</p>}
                {s.quote && (
                  <p className="mt-1 font-serif text-[0.95rem] text-ink-2">
                    “{s.quote}” {s.verified === true ? <span className="font-sans text-xs text-ok">확인됨</span> : s.verified === false ? <span className="font-sans text-xs text-bad">슬라이드에서 찾지 못함</span> : null}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
