import { useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import { ArrowDown, ArrowUp, Download, FilePen, Plus, Printer, Trash2 } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { newId } from '@/core/id';
import { noteToHtmlDocument, noteToMarkdown, originLabel } from '@/core/study/notes';
import { deleteNote, renameNote, saveNoteBlocks } from '@/core/study/store';
import { NOTE_KIND_LABEL, type NoteBlock } from '@/core/study/types';
import { useNote } from '@/app/data';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Menu } from '@/ui/Menu';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Dialog, Spinner, TextArea, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';
import { NotFound } from './NotFound';

const db = getDb();

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function NoteEditorPage() {
  const { noteId } = useParams();
  const { course, lectures } = useOutletContext<CourseCtx>();
  const note = useNote(noteId);
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [title, setTitle] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  if (note === null) return <NotFound what="노트가" />;
  if (!note) return <Spinner />;

  const lectureTitle = (id: string) => lectures.find((l) => l.id === id)?.title;
  const slug = note.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'note';

  const persist = async (blocks: NoteBlock[]) => {
    try {
      await saveNoteBlocks(db, note.id, blocks);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '노트를 저장하지 못했습니다.', 'error');
    }
  };

  const startEdit = (b: NoteBlock) => {
    setEditing(b.id);
    setDraft(b.text);
  };

  const move = (i: number, d: number) => {
    const next = [...note.blocks];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    void persist(next);
  };

  return (
    <div>
      <nav aria-label="이동 경로" className="text-[13px] text-ink-3 print:hidden">
        <Link to={`/course/${course.id}/notes`} className="hover:underline">
          노트
        </Link>
      </nav>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="note-title-input" className="sr-only">
            노트 제목
          </label>
          <TextInput
            id="note-title-input"
            value={title ?? note.title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={async () => {
              if (title !== undefined && title.trim() && title.trim() !== note.title) await renameNote(db, note.id, title);
              setTitle(undefined);
            }}
            className="min-h-11 border-transparent bg-transparent px-0 text-2xl font-semibold tracking-tight hover:border-rule focus-visible:border-rule print:border-0"
          />
          <p className="text-sm text-ink-3">
            {NOTE_KIND_LABEL[note.kind]}
            {note.lectureId && lectureTitle(note.lectureId) ? `, ${lectureTitle(note.lectureId)}` : ''}
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Menu
            label="이 노트 내보내기"
            text="내보내기"
            icon={<Download className="size-4" aria-hidden />}
            items={[
              { label: '마크다운(.md)', onSelect: () => download(`${slug}.md`, 'text/markdown', noteToMarkdown(note, lectureTitle)) },
              { label: '웹 페이지(.html)', onSelect: () => void noteToHtmlDocument(note, lectureTitle).then((h) => download(`${slug}.html`, 'text/html', h)) },
            ]}
          />
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> 인쇄 또는 PDF로 저장
          </Button>
          <Button variant="danger" onClick={() => setDeleting(true)} aria-label="노트 삭제">
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <ol className="mt-6 flex flex-col gap-4">
        {note.blocks.map((b, i) => (
          <li key={b.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4 print:break-inside-avoid print:border-0 print:p-0">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3 print:hidden">
              <span className={`font-medium ${b.origin === 'user' ? 'text-accent' : 'text-ink-2'}`}>{originLabel(b.origin)}</span>
              <BasisChip basis={b.basis} sources={b.sources} />
              {b.sources.length > 0 && <SourceStatusChip sources={b.sources} />}
            </div>
            {editing === b.id ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <label htmlFor={`edit-${b.id}`} className="mb-1 block text-sm font-medium">
                    편집(마크다운, 수식은 $x^2$처럼)
                  </label>
                  <TextArea id={`edit-${b.id}`} rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[13px]" autoFocus />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={async () => {
                        await persist(note.blocks.map((x) => (x.id === b.id ? { ...x, text: draft } : x)));
                        setEditing(undefined);
                      }}
                    >
                      블록 저장
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
                      취소
                    </Button>
                  </div>
                  {b.origin !== 'user' && <p className="mt-2 text-[13px] text-ink-3">고친 내용을 저장하면 이 블록은 내가 쓴 것으로 표시됩니다. 출처는 그대로 남습니다.</p>}
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium">미리보기</p>
                  <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">{draft.trim() ? <LazyMarkdown>{draft}</LazyMarkdown> : <span className="text-sm text-ink-3">아직 내용이 없습니다</span>}</div>
                </div>
              </div>
            ) : (
              <>
                {b.text.trim() ? <LazyMarkdown>{b.text}</LazyMarkdown> : <p className="text-sm text-ink-3">빈 블록입니다. 편집을 눌러 내용을 쓰세요.</p>}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
                  <SourceList sources={b.sources} />
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(b)}>
                      <FilePen className="size-4" aria-hidden /> 편집
                    </Button>
                    <button type="button" aria-label="블록 위로 이동" title="위로 이동" disabled={i === 0} onClick={() => move(i, -1)} className="inline-flex size-8 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30">
                      <ArrowUp className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label="블록 아래로 이동" title="아래로 이동" disabled={i === note.blocks.length - 1} onClick={() => move(i, 1)} className="inline-flex size-8 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30">
                      <ArrowDown className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label="블록 삭제" title="블록 삭제" onClick={() => void persist(note.blocks.filter((x) => x.id !== b.id))} className="inline-flex size-8 items-center justify-center rounded text-ink-3 hover:bg-bad-soft hover:text-bad">
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-4 print:hidden">
        <Button
          onClick={async () => {
            const nb: NoteBlock = { id: newId(), text: '', origin: 'user', basis: 'outside', sources: [], updatedAt: Date.now() };
            await persist([...note.blocks, nb]);
            startEdit(nb);
          }}
        >
          <Plus className="size-4" aria-hidden /> 블록 추가
        </Button>
      </div>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="이 노트를 삭제할까요?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              취소
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await deleteNote(db, note.id);
                toast.show('노트를 삭제했습니다.', 'ok');
                navigate(`/course/${course.id}/notes`);
              }}
            >
              노트 삭제
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">“{note.title}”과(와) 그 안에 쓴 모든 내용이 이 기기에서 지워집니다.</p>
      </Dialog>
    </div>
  );
}
