import { useEffect, useState } from 'react';
import { getDb, type LectureRow } from '@/core/db/db';
import { createCard, updateCard } from '@/core/study/store';
import { BASES, BASIS_LABEL, CARD_TYPES, CARD_TYPE_LABEL, type Basis, type CardRow, type CardType } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Button, Dialog, Field, Select, TextArea, TextInput } from '@/ui/primitives';
import { SourceList } from './Sources';

const db = getDb();

/** Create or edit one card, with a live preview of how it will look (markdown, maths, code). */
export function CardEditor({ open, onClose, courseId, lectures, card }: { open: boolean; onClose: () => void; courseId: string; lectures: LectureRow[]; card?: CardRow }) {
  const toast = useToast();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [type, setType] = useState<CardType>('qa');
  const [basis, setBasis] = useState<Basis>('uncertain');
  const [tags, setTags] = useState('');
  const [lectureId, setLectureId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFront(card?.front ?? '');
    setBack(card?.back ?? '');
    setType(card?.type ?? 'qa');
    setBasis(card?.basis ?? 'outside');
    setTags(card?.tags.join(', ') ?? '');
    setLectureId(card?.lectureId ?? '');
  }, [open, card]);

  const save = async () => {
    setBusy(true);
    try {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (card) {
        await updateCard(db, card.id, { front, back, type, basis, tags: tagList, ...(lectureId ? { lectureId } : {}) });
        toast.show('카드를 저장했습니다.', 'ok');
      } else {
        await createCard(db, { courseId, type, front, back, basis, tags: tagList, ...(lectureId ? { lectureId } : {}) });
        toast.show('카드를 추가했습니다.', 'ok');
      }
      onClose();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '카드를 저장하지 못했습니다.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={card ? '카드 편집' : '새 카드'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" type="submit" form="card-form" disabled={busy || !front.trim() || !back.trim()}>
            {card ? '카드 저장' : '카드 추가'}
          </Button>
        </>
      }
    >
      <form
        id="card-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="카드 종류" htmlFor="card-type">
            <Select id="card-type" value={type} onChange={(e) => setType(e.target.value as CardType)}>
              {CARD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CARD_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="어디에서 온 내용인가요?" htmlFor="card-basis">
            <Select id="card-basis" value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABEL[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="강의" htmlFor="card-lecture">
            <Select id="card-lecture" value={lectureId} onChange={(e) => setLectureId(e.target.value)}>
              <option value="">없음</option>
              {lectures.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="앞면(질문)" htmlFor="card-front" hint="마크다운을 쓸 수 있습니다. 수식은 $x^2$처럼, 코드는 ``` 펜스 안에 쓰세요.">
          <TextArea id="card-front" rows={3} value={front} onChange={(e) => setFront(e.target.value)} />
        </Field>
        <Field label="뒷면(답)" htmlFor="card-back">
          <TextArea id="card-back" rows={4} value={back} onChange={(e) => setBack(e.target.value)} />
        </Field>
        <Field label="태그" htmlFor="card-tags" hint="쉼표로 구분하세요.">
          <TextInput id="card-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-medium">앞면 미리보기</h3>
            <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">{front.trim() ? <LazyMarkdown>{front}</LazyMarkdown> : <span className="text-sm text-ink-3">아직 내용이 없습니다</span>}</div>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">뒷면 미리보기</h3>
            <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">{back.trim() ? <LazyMarkdown>{back}</LazyMarkdown> : <span className="text-sm text-ink-3">아직 내용이 없습니다</span>}</div>
          </div>
        </div>
        {card && card.sources.length > 0 && <SourceList sources={card.sources} />}
      </form>
    </Dialog>
  );
}
