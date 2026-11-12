import { useRef, useState, type DragEvent } from 'react';
import { Link, useOutletContext } from 'react-router';
import { ArrowDown, ArrowUp, Download, FilePlus2, FileUp, Pencil, RefreshCw, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { getDb, type LectureRow } from '@/core/db/db';
import type { LectureFormat } from '@/core/pptx/model';
import { deleteLecture, renameLecture, reorderLectures } from '@/core/db/library';
import { useToast } from '@/app/toast';
import { ACCEPTED_FILES } from '@/app/importer';
import { useImporter, type ImportItem } from '@/app/useImporter';
import { Button, Callout, ConfidencePill, Dialog, EmptyState, Field, formatBytes, Spinner, TextInput } from '@/ui/primitives';
import { Menu } from '@/ui/Menu';
import type { CourseCtx } from './CourseLayout';

const db = getDb();

/** PDF lectures count pages, PowerPoint lectures count slides. */
function countLabel(n: number, format: LectureFormat | undefined): string {
  return format === 'pdf' ? `${n}쪽` : `슬라이드 ${n}장`;
}

export function CoursePage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const importer = useImporter(course.id);
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<LectureRow | undefined>();
  const [deleting, setDeleting] = useState<LectureRow | undefined>();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) importer.enqueue(files);
  };

  const move = async (index: number, delta: number) => {
    const ids = lectures.map((l) => l.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    try {
      await reorderLectures(db, course.id, ids);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '순서를 바꾸지 못했습니다.', 'error');
    }
  };

  const download = async (l: LectureRow) => {
    const row = await db.files.get(l.id);
    if (!row) {
      toast.show('이 강의의 원본 파일이 저장되어 있지 않습니다.', 'error');
      return;
    }
    const url = URL.createObjectURL(row.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = l.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => fileInput.current?.click()}>
          <FilePlus2 className="size-4" aria-hidden /> 강의 추가
        </Button>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="sr-only"
        aria-label="강의 파일 선택"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files?.length) importer.enqueue([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept={ACCEPTED_FILES}
        className="sr-only"
        aria-label="새 버전의 강의 파일 선택"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && replaceTarget.current) importer.enqueue([f], replaceTarget.current);
          e.target.value = '';
        }}
      />

      <section
        aria-label="파일 올리기"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-6 rounded-[var(--radius-panel)] border-2 border-dashed px-5 py-6 text-center transition-colors ${dragging ? 'border-accent bg-accent-soft' : 'border-rule-strong'}`}
      >
        <Upload className="mx-auto size-5 text-ink-3" aria-hidden />
        <p className="mt-2 text-sm text-ink">
          PowerPoint 또는 PDF 파일을 여기에 끌어다 놓거나{' '}
          <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => fileInput.current?.click()}>
            파일을 선택하세요
          </button>
        </p>
        <p className="mt-1 text-[13px] text-ink-3">파일은 이 기기에서만 읽고 어디에도 업로드하지 않습니다. 여러 개를 한 번에 추가할 수 있습니다. 스캔한 PDF는 페이지 이미지로 보여 주지만 글자를 인식하지 않습니다.</p>
      </section>

      {importer.items.length > 0 && <ImportQueue items={importer.items} onDecide={importer.decide} onCancel={importer.cancel} onClear={importer.clearFinished} />}

      <section className="mt-8" aria-labelledby="lectures-h">
        <h2 id="lectures-h" className="text-lg font-semibold">
          강의
        </h2>
        {lectures.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="아직 강의가 없습니다" action={<Button variant="primary" onClick={() => fileInput.current?.click()}><FileUp className="size-4" aria-hidden /> 첫 강의 추가</Button>}>
              교수님이 준 PowerPoint나 PDF 강의 자료를 추가하세요. 슬라이드나 페이지별로 나누어 읽고, 검색하고, 공부할 수 있습니다.
            </EmptyState>
          </div>
        ) : (
          <ol className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
            {lectures.map((l, i) => {
              const attn = l.report.slidesRequiringAttention.length;
              return (
                <li key={l.id} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-3 lg:grid-cols-[2rem_minmax(0,1fr)_6rem_11rem_auto] lg:px-4">
                  <span className="text-sm tabular-nums text-ink-3" aria-label={`${i + 1}번째 강의`}>
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <Link to={`/lecture/${l.id}`} className="block truncate font-medium text-ink hover:text-accent">
                      {l.title}
                    </Link>
                    <p className="truncate text-[13px] text-ink-3">
                      {l.fileName} <span className="sr-only">,</span> {formatBytes(l.fileSize)}
                    </p>
                  </div>
                  <p className="col-start-2 text-sm text-ink-2 lg:col-start-auto">
                    {l.meta.format === 'pdf' && <span className="mr-1.5 rounded bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-2">PDF</span>}
                    {countLabel(l.slideCount, l.meta.format)}
                  </p>
                  <div className="col-start-2 flex items-center gap-2 lg:col-start-auto">
                    <ConfidencePill value={l.report.confidenceLabel} />
                    {attn > 0 && (
                      <Link to={`/lecture/${l.id}/report`} className="inline-flex items-center gap-1 text-[13px] text-bad underline underline-offset-2">
                        <TriangleAlert className="size-3.5" aria-hidden /> 확인 필요 {countLabel(attn, l.meta.format)}
                      </Link>
                    )}
                  </div>
                  <div className="col-start-3 row-start-1 flex items-center lg:col-start-auto lg:row-start-auto">
                    <button type="button" aria-label={`${l.title} 위로 이동`} title="위로 이동" disabled={i === 0} onClick={() => void move(i, -1)} className="hidden size-9 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30 lg:inline-flex">
                      <ArrowUp className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label={`${l.title} 아래로 이동`} title="아래로 이동" disabled={i === lectures.length - 1} onClick={() => void move(i, 1)} className="hidden size-9 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30 lg:inline-flex">
                      <ArrowDown className="size-4" aria-hidden />
                    </button>
                    <Menu
                      label={`${l.title} 작업`}
                      items={[
                        { label: '이름 바꾸기', icon: <Pencil className="size-4" aria-hidden />, onSelect: () => setRenaming(l) },
                        {
                          label: '새 버전 파일로 바꾸기',
                          icon: <RefreshCw className="size-4" aria-hidden />,
                          onSelect: () => {
                            replaceTarget.current = l.id;
                            replaceInput.current?.click();
                          },
                        },
                        { label: '원본 파일 내려받기', icon: <Download className="size-4" aria-hidden />, onSelect: () => void download(l) },
                        { label: '위로 이동', icon: <ArrowUp className="size-4" aria-hidden />, onSelect: () => void move(i, -1), disabled: i === 0 },
                        { label: '아래로 이동', icon: <ArrowDown className="size-4" aria-hidden />, onSelect: () => void move(i, 1), disabled: i === lectures.length - 1 },
                        { label: '강의 삭제', icon: <Trash2 className="size-4" aria-hidden />, onSelect: () => setDeleting(l), danger: true },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <RenameDialog lecture={renaming} onClose={() => setRenaming(undefined)} />
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title="이 강의를 삭제할까요?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              취소
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                await deleteLecture(db, deleting.id);
                toast.show(`“${deleting.title}” 강의를 삭제했습니다.`, 'ok');
                setDeleting(undefined);
              }}
            >
              강의 삭제
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          “{deleting?.title}” 강의와 그 슬라이드(또는 페이지), 이미지, 저장된 원본 파일이 이 기기에서 삭제됩니다. 되돌릴 수 없으니 나중에 필요할 수 있다면 먼저 백업을 내보내세요.
        </p>
      </Dialog>
    </div>
  );
}

function ImportQueue({ items, onDecide, onCancel, onClear }: { items: ImportItem[]; onDecide: (id: string, c: 'skip' | 'add' | 'replace') => void; onCancel: (id: string) => void; onClear: () => void }) {
  const finished = items.some((i) => ['done', 'skipped', 'error'].includes(i.status));
  return (
    <section className="mt-6" aria-labelledby="queue-h" aria-live="polite">
      <div className="flex items-center justify-between">
        <h2 id="queue-h" className="text-base font-semibold">
          가져오는 중
        </h2>
        {finished && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            끝난 항목 지우기
          </Button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
        {items.map((it) => (
          <li key={it.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate font-medium">{it.name}</p>
              <div className="flex items-center gap-2 text-ink-2">
                {it.status === 'queued' && '대기 중'}
                {it.status === 'parsing' && (
                  <Spinner label={it.progress && it.progress.total ? `${it.format === 'pdf' ? '페이지' : '슬라이드'} ${it.progress.done}/${it.progress.total} 읽는 중` : '파일 여는 중'} />
                )}
                {it.status === 'saving' && <Spinner label="저장 중" />}
                {it.status === 'skipped' && '건너뜀'}
                {it.status === 'done' && it.result && (
                  <span>
                    {it.result.replaced ? '바꿈' : '가져옴'}: {countLabel(it.result.slides, it.format)}
                    {it.result.attention > 0 ? (
                      <>
                        ,{' '}
                        <Link className="text-bad underline underline-offset-2" to={`/lecture/${it.result.lectureId}/report`}>
                          확인 필요 {countLabel(it.result.attention, it.format)}
                        </Link>
                      </>
                    ) : (
                      <>
                        ,{' '}
                        <Link className="text-accent underline underline-offset-2" to={`/lecture/${it.result.lectureId}`}>
                          열기
                        </Link>
                      </>
                    )}
                  </span>
                )}
                {(it.status === 'queued' || it.status === 'parsing') && (
                  <Button size="sm" variant="ghost" onClick={() => onCancel(it.id)} aria-label={`${it.name} 가져오기 취소`}>
                    취소
                  </Button>
                )}
              </div>
            </div>
            {it.status === 'error' && (
              <div className="mt-2">
                <Callout tone="bad" title="이 파일을 가져오지 못했습니다">
                  {it.error}
                </Callout>
              </div>
            )}
            {it.status === 'decision' && it.decision && (
              <div className="mt-2 rounded-[var(--radius-control)] bg-warn-soft p-3">
                {it.decision.kind === 'duplicate' && (
                  <>
                    <p className="text-ink">
                      똑같은 파일이 이미 자료실에 있습니다: {it.decision.where.map((w) => `“${w.title}”(${w.courseName})`).join(', ')}.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => onDecide(it.id, 'skip')}>
                        건너뛰기
                      </Button>
                      <Button size="sm" onClick={() => onDecide(it.id, 'add')}>
                        그래도 가져오기
                      </Button>
                    </div>
                  </>
                )}
                {it.decision.kind === 'sameName' && (
                  <>
                    <p className="text-ink">
                      같은 이름의 파일로 만든 강의가 이미 있습니다: “{it.decision.existing.title}”({it.decision.existing.slides}개). 이 파일은 {it.decision.incoming.slides}개입니다.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="primary" onClick={() => onDecide(it.id, 'replace')}>
                        기존 강의 바꾸기
                      </Button>
                      <Button size="sm" onClick={() => onDecide(it.id, 'add')}>
                        새 강의로 추가
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onDecide(it.id, 'skip')}>
                        건너뛰기
                      </Button>
                    </div>
                  </>
                )}
                {it.decision.kind === 'confirmReplace' && (
                  <>
                    <p className="text-ink">
                      “{it.decision.existing.title}”({it.decision.existing.slides}개)을 이 파일({it.decision.incoming.slides}개)로 바꿀까요? 강의의 위치와 제목은 그대로 유지됩니다.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => onDecide(it.id, 'replace')}>
                        강의 바꾸기
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onDecide(it.id, 'skip')}>
                        취소
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RenameDialog({ lecture, onClose }: { lecture: LectureRow | undefined; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [last, setLast] = useState<string | undefined>();
  if (lecture && last !== lecture.id) {
    setLast(lecture.id);
    setTitle(lecture.title);
  }
  const save = async () => {
    if (!lecture || !title.trim()) return;
    await renameLecture(db, lecture.id, title);
    onClose();
  };
  return (
    <Dialog
      open={!!lecture}
      onClose={onClose}
      title="강의 이름 바꾸기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" type="submit" form="rename-form" disabled={!title.trim()}>
            이름 저장
          </Button>
        </>
      }
    >
      <form
        id="rename-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="강의 제목" htmlFor="lecture-title">
          <TextInput id="lecture-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}

