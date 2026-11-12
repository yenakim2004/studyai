import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Info } from 'lucide-react';
import { useCourses, useSetting } from '@/app/data';
import { useToast } from '@/app/toast';
import { getDb } from '@/core/db/db';
import { Button } from '@/ui/primitives';
import { SAMPLE_COURSE_SETTING } from './setting';

const db = getDb();

/**
 * Shown on every page of the static public demo (never in the regular app). It says, in plain words, what a visitor needs to
 * know before trying it, and offers the one-click sample course. The lecture builder and the sample material are loaded only
 * when the button is pressed.
 */
export function DemoBanner() {
  const navigate = useNavigate();
  const toast = useToast();
  const courses = useCourses();
  const [sampleId] = useSetting<string>(SAMPLE_COURSE_SETTING);
  const [busy, setBusy] = useState(false);
  const have = !!sampleId && (courses ?? []).some((c) => c.id === sampleId);

  const load = async () => {
    setBusy(true);
    try {
      const { loadSampleCourse } = await import('./sample-course');
      const { courseId, created } = await loadSampleCourse(db);
      if (created) toast.show('예시 과목이 준비되었습니다. 강의와 문제는 지어낸 내용입니다.', 'ok');
      navigate(`/course/${courseId}`);
    } catch (err) {
      toast.show(err instanceof Error ? `예시 과목을 불러오지 못했습니다: ${err.message}` : '예시 과목을 불러오지 못했습니다.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="이 데모에 대해" className="border-b border-rule bg-accent-soft text-ink print:hidden">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-sm md:px-8">
        <p className="min-w-0 flex-1 basis-72">
          <Info className="mr-1.5 inline size-4 align-text-bottom" aria-hidden />
          <strong className="font-semibold">데모.</strong> 예시 내용은 지어낸 것입니다. 추가한 자료는 이 브라우저에만 남고 업로드되지 않습니다. 데모에서는 AI 기능을 쓸 수 없습니다.{' '}
          <a className="font-medium underline underline-offset-2" href="https://github.com/zuhairhalawa/studyai" target="_blank" rel="noopener noreferrer">
            앱 받기
          </a>
        </p>
        <Button variant="primary" size="sm" onClick={() => void load()} disabled={busy}>
          {busy ? '예시 과목을 불러오는 중…' : have ? '예시 과목 열기' : '예시 과목 불러오기'}
        </Button>
      </div>
    </section>
  );
}
