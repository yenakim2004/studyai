import { useCallback, useEffect, useRef, useState } from 'react';
import type { LectureFormat } from '@/core/pptx/model';
import { getDb } from '@/core/db/db';
import { findDuplicates, findSameNamed, importLecture, replaceLecture } from '@/core/db/library';
import { newId } from '@/core/id';
import { describeImportError, formatOf, isAbort, parseFile, rejectionMessage } from './importer';

const db = getDb();

export type Choice = 'skip' | 'add' | 'replace';

export type Decision =
  | { kind: 'duplicate'; where: { lectureId: string; title: string; courseName: string }[] }
  | { kind: 'sameName'; existing: { lectureId: string; title: string; slides: number }; incoming: { slides: number } }
  | { kind: 'confirmReplace'; existing: { lectureId: string; title: string; slides: number }; incoming: { slides: number } };

export interface ImportItem {
  id: string;
  name: string;
  size: number;
  /** Undefined for a file that is not accepted. */
  format?: LectureFormat;
  status: 'queued' | 'parsing' | 'decision' | 'saving' | 'done' | 'skipped' | 'error';
  progress?: { done: number; total: number };
  error?: string;
  decision?: Decision;
  result?: { lectureId: string; title: string; slides: number; attention: number; replaced: boolean };
}

interface Job {
  item: ImportItem;
  file: File;
  /** When set, the file replaces this lecture (after confirmation). */
  replaceLectureId?: string;
}

/** Sequential import queue for one course. A file can be cancelled while it is read or waiting for a decision; leaving the page cancels them all. */
export function useImporter(courseId: string | undefined) {
  const [items, setItems] = useState<ImportItem[]>([]);
  const waiting = useRef(new Map<string, (c: Choice) => void>());
  const controllers = useRef(new Map<string, AbortController>());
  const chain = useRef(Promise.resolve());

  useEffect(() => {
    const live = controllers.current;
    const asked = waiting.current;
    return () => {
      for (const c of live.values()) c.abort();
      for (const resolve of asked.values()) resolve('skip');
    };
  }, []);

  const patch = useCallback((id: string, p: Partial<ImportItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  const ask = useCallback(
    (id: string, decision: Decision) =>
      new Promise<Choice>((resolve) => {
        waiting.current.set(id, resolve);
        patch(id, { status: 'decision', decision });
      }),
    [patch],
  );

  const run = useCallback(
    async (job: Job) => {
      if (!courseId) return;
      const { item, file } = job;
      const controller = controllers.current.get(item.id);
      if (!controller || controller.signal.aborted) return;
      try {
        patch(item.id, { status: 'parsing', progress: { done: 0, total: 0 } });
        const { deck, bytes } = await parseFile(file, { signal: controller.signal, onProgress: (done, total) => patch(item.id, { progress: { done, total } }) });
        const attention = deck.report.slidesRequiringAttention.length;

        let choice: Choice = 'add';
        let target = job.replaceLectureId;
        if (target) {
          const existing = await db.lectures.get(target);
          if (!existing) throw new Error('바꿀 강의가 더 이상 없습니다.');
          choice = await ask(item.id, { kind: 'confirmReplace', existing: { lectureId: existing.id, title: existing.title, slides: existing.slideCount }, incoming: { slides: deck.slides.length } });
        } else {
          const dups = await findDuplicates(db, deck.fileHash);
          if (dups.length > 0) {
            choice = await ask(item.id, { kind: 'duplicate', where: dups.map((d) => ({ lectureId: d.lecture.id, title: d.lecture.title, courseName: d.course?.name ?? '다른 과목' })) });
          } else {
            const same = await findSameNamed(db, courseId, file.name);
            if (same) {
              choice = await ask(item.id, { kind: 'sameName', existing: { lectureId: same.id, title: same.title, slides: same.slideCount }, incoming: { slides: deck.slides.length } });
              if (choice === 'replace') target = same.id;
            }
          }
        }

        if (choice === 'skip' || controller.signal.aborted) {
          patch(item.id, { status: 'skipped', decision: undefined });
          return;
        }
        patch(item.id, { status: 'saving', decision: undefined });
        const lecture =
          choice === 'replace' && target
            ? await replaceLecture(db, target, { fileName: file.name, bytes, deck })
            : await importLecture(db, { courseId, fileName: file.name, bytes, deck });
        patch(item.id, { status: 'done', result: { lectureId: lecture.id, title: lecture.title, slides: deck.slides.length, attention, replaced: choice === 'replace' } });
        // Ask the browser not to evict the library under storage pressure (best effort, free).
        void navigator.storage?.persist?.();
      } catch (err) {
        patch(item.id, isAbort(err) ? { status: 'skipped', decision: undefined } : { status: 'error', error: describeImportError(err), decision: undefined });
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [ask, courseId, patch],
  );

  const enqueue = useCallback(
    (files: File[], replaceLectureId?: string) => {
      const jobs: Job[] = files.map((file) => {
        const format = formatOf(file.name);
        const item: ImportItem = format ? { id: newId(), name: file.name, size: file.size, format, status: 'queued' } : { id: newId(), name: file.name, size: file.size, status: 'error', error: rejectionMessage(file.name) };
        if (format) controllers.current.set(item.id, new AbortController());
        return { item, file, replaceLectureId };
      });
      setItems((xs) => [...xs, ...jobs.map((j) => j.item)]);
      for (const job of jobs) {
        if (job.item.status === 'error') continue;
        chain.current = chain.current.then(() => run(job));
      }
    },
    [run],
  );

  const decide = useCallback((id: string, choice: Choice) => {
    waiting.current.get(id)?.(choice);
    waiting.current.delete(id);
  }, []);

  /** Stop a file that is waiting, being read or waiting for a decision. Nothing of it is saved. */
  const cancel = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      controllers.current.delete(id);
      decide(id, 'skip');
      setItems((xs) => xs.map((x) => (x.id === id && (x.status === 'queued' || x.status === 'parsing' || x.status === 'decision') ? { ...x, status: 'skipped', decision: undefined } : x)));
    },
    [decide],
  );

  const clearFinished = useCallback(() => setItems((xs) => xs.filter((x) => x.status === 'queued' || x.status === 'parsing' || x.status === 'decision' || x.status === 'saving')), []);

  const busy = items.some((x) => x.status === 'queued' || x.status === 'parsing' || x.status === 'saving' || x.status === 'decision');
  return { items, enqueue, decide, cancel, clearFinished, busy };
}
