import { newId } from '../id';
import type { ExtractionReport, ParsedDeck } from '../pptx/model';
import { carryPictureTexts, withPictureText } from '../pptx/picturetext';
import { rebuildReport } from '../pptx/report';
import type { CourseRow, LectureRow, MediaRow, SlideRow, StudyDB } from './db';

/** Strip hash prefixes and the extension from a file name to get a readable lecture title. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(pptx|pptm|ppsx|potx|pdf)$/i, '').replace(/^[0-9a-f]{32}_/i, '');
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

export async function createCourse(db: StudyDB, input: { name: string; code?: string; color?: number }): Promise<CourseRow> {
  const name = input.name.trim();
  if (!name) throw new Error('과목 이름을 입력하세요.');
  const order = (await db.courses.orderBy('order').last())?.order ?? -1;
  const now = Date.now();
  const row: CourseRow = {
    id: newId(),
    name,
    color: input.color ?? (await db.courses.count()) % 8,
    createdAt: now,
    updatedAt: now,
    archived: false,
    order: order + 1,
  };
  const code = input.code?.trim();
  if (code) row.code = code;
  await db.courses.add(row);
  return row;
}

export async function updateCourse(db: StudyDB, id: string, patch: Partial<Omit<CourseRow, 'id' | 'createdAt'>>): Promise<void> {
  const n = await db.courses.update(id, { ...patch, updatedAt: Date.now() });
  if (n === 0) throw new Error('과목을 찾을 수 없습니다.');
}

/** Delete a course and everything that belongs to it. */
export async function deleteCourse(db: StudyDB, id: string): Promise<void> {
  const lectures = await db.lectures.where('courseId').equals(id).primaryKeys();
  await db.transaction('rw', [db.courses, db.lectures, db.slides, db.media, db.files, db.notes, db.cards, db.reviews, db.questions, db.exams, db.attempts, db.activity, db.packs, db.tutorSessions, db.tutorMessages], async () => {
    for (const lectureId of lectures) await removeLectureData(db, lectureId);
    // Study material belongs to the course: it goes with it (the course dialog asks for explicit confirmation).
    for (const t of [db.notes, db.cards, db.reviews, db.questions, db.exams, db.attempts, db.activity, db.packs, db.tutorSessions, db.tutorMessages] as const) {
      await (t as unknown as { where(k: string): { equals(v: string): { delete(): Promise<number> } } }).where('courseId').equals(id).delete();
    }
    await db.courses.delete(id);
  });
}

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

export interface DuplicateInfo {
  lecture: LectureRow;
  course: CourseRow | undefined;
}

/** Find lectures that were imported from an identical file (same SHA-256). */
export async function findDuplicates(db: StudyDB, fileHash: string): Promise<DuplicateInfo[]> {
  const lectures = await db.lectures.where('fileHash').equals(fileHash).toArray();
  const out: DuplicateInfo[] = [];
  for (const lecture of lectures) out.push({ lecture, course: await db.courses.get(lecture.courseId) });
  return out;
}

/** Find a lecture in the same course with the same file name (candidate for re-import). */
export async function findSameNamed(db: StudyDB, courseId: string, fileName: string): Promise<LectureRow | undefined> {
  return (await db.lectures.where('courseId').equals(courseId).toArray()).find((l) => l.fileName.toLowerCase() === fileName.toLowerCase());
}

function mediaRows(lectureId: string, deck: ParsedDeck): MediaRow[] {
  return [...deck.media.values()].map((m) => ({
    id: `${lectureId}|${m.key}`,
    lectureId,
    key: m.key,
    mime: m.mime,
    blob: new Blob([m.bytes as unknown as BlobPart], { type: m.mime }),
  }));
}

function slideRows(lectureId: string, deck: ParsedDeck): SlideRow[] {
  return deck.slides.map((s) => ({ ...s, lectureId }));
}

export interface ImportInput {
  courseId: string;
  fileName: string;
  /** Original file bytes (kept on-device so the lecture can be re-imported/exported). */
  bytes: Uint8Array;
  deck: ParsedDeck;
  title?: string;
}

/** Add a parsed deck to a course as a new lecture. */
export async function importLecture(db: StudyDB, input: ImportInput): Promise<LectureRow> {
  const course = await db.courses.get(input.courseId);
  if (!course) throw new Error('과목을 찾을 수 없습니다.');
  const id = newId();
  const now = Date.now();
  const last = await db.lectures.where('courseId').equals(input.courseId).toArray();
  const order = last.reduce((m, l) => Math.max(m, l.order), -1) + 1;
  const row: LectureRow = {
    id,
    courseId: input.courseId,
    title: input.title?.trim() || titleFromFileName(input.fileName),
    order,
    fileName: input.fileName,
    fileHash: input.deck.fileHash,
    fileSize: input.deck.fileSize,
    importedAt: now,
    updatedAt: now,
    revision: 1,
    slideCount: input.deck.slides.length,
    meta: input.deck.meta,
    report: input.deck.report,
  };
  await db.transaction('rw', [db.lectures, db.slides, db.media, db.files], async () => {
    await db.lectures.add(row);
    await db.slides.bulkAdd(slideRows(id, input.deck));
    await db.media.bulkAdd(mediaRows(id, input.deck));
    await db.files.put({ lectureId: id, name: input.fileName, blob: new Blob([input.bytes as unknown as BlobPart]) });
  });
  return row;
}

/**
 * Replace the content of an existing lecture with a newer version of the file.
 * The lecture keeps its id, course, position and (custom) title; `revision` is bumped.
 */
export async function replaceLecture(db: StudyDB, lectureId: string, input: Omit<ImportInput, 'courseId'>): Promise<LectureRow> {
  const prev = await db.lectures.get(lectureId);
  if (!prev) throw new Error('강의를 찾을 수 없습니다.');
  // Text the student typed for pictures that are still in the new file is kept.
  const slides = carryPictureTexts(await loadSlides(db, lectureId), input.deck.slides);
  const hasTyped = slides.some((s) => s.pictureTexts?.length);
  const next: LectureRow = {
    ...prev,
    fileName: input.fileName,
    fileHash: input.deck.fileHash,
    fileSize: input.deck.fileSize,
    updatedAt: Date.now(),
    revision: prev.revision + 1,
    slideCount: input.deck.slides.length,
    meta: input.deck.meta,
    report: hasTyped ? keepLimitations(input.deck.report, rebuildReport(input.deck.report, slides)) : input.deck.report,
  };
  await db.transaction('rw', [db.lectures, db.slides, db.media, db.files], async () => {
    await db.slides.where('lectureId').equals(lectureId).delete();
    await db.media.where('lectureId').equals(lectureId).delete();
    await db.slides.bulkAdd(slides.map((s) => ({ ...s, lectureId })));
    await db.media.bulkAdd(mediaRows(lectureId, input.deck));
    await db.files.put({ lectureId, name: input.fileName, blob: new Blob([input.bytes as unknown as BlobPart]) });
    await db.lectures.put(next);
  });
  return next;
}

/** The limitations list belongs to the file format the report was made for (PowerPoint or PDF); rebuilding the counts keeps it. */
function keepLimitations(previous: ExtractionReport, rebuilt: ExtractionReport): ExtractionReport {
  return { ...rebuilt, limitations: previous.limitations };
}

async function removeLectureData(db: StudyDB, lectureId: string): Promise<void> {
  await db.slides.where('lectureId').equals(lectureId).delete();
  await db.media.where('lectureId').equals(lectureId).delete();
  await db.files.delete(lectureId);
  await db.lectures.delete(lectureId);
}

export async function deleteLecture(db: StudyDB, lectureId: string): Promise<void> {
  await db.transaction('rw', [db.lectures, db.slides, db.media, db.files], () => removeLectureData(db, lectureId));
}

export async function renameLecture(db: StudyDB, lectureId: string, title: string): Promise<void> {
  const t = title.trim();
  if (!t) throw new Error('강의 제목을 입력하세요.');
  await db.lectures.update(lectureId, { title: t, updatedAt: Date.now() });
}

/** Persist a new lecture order for a course (ids in display order). */
export async function reorderLectures(db: StudyDB, courseId: string, orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.lectures, async () => {
    const existing = await db.lectures.where('courseId').equals(courseId).primaryKeys();
    if (existing.length !== orderedIds.length || !orderedIds.every((id) => existing.includes(id))) {
      throw new Error('강의 순서가 이 과목의 강의 목록과 맞지 않습니다. 새로 고친 뒤 다시 시도하세요.');
    }
    for (let i = 0; i < orderedIds.length; i++) await db.lectures.update(orderedIds[i]!, { order: i });
  });
}

export async function listLectures(db: StudyDB, courseId: string): Promise<LectureRow[]> {
  return (await db.lectures.where('courseId').equals(courseId).toArray()).sort((a, b) => a.order - b.order);
}

export async function loadSlides(db: StudyDB, lectureId: string): Promise<SlideRow[]> {
  return (await db.slides.where('lectureId').equals(lectureId).toArray()).sort((a, b) => a.index - b.index);
}

export async function loadMedia(db: StudyDB, lectureId: string): Promise<Map<string, MediaRow>> {
  const rows = await db.media.where('lectureId').equals(lectureId).toArray();
  return new Map(rows.map((r) => [r.key, r]));
}

/**
 * Stores the words of a picture, typed by the student, on its slide (an empty text removes them). The slide's study text,
 * warnings and confidence follow, and so does the lecture's extraction report.
 */
export async function setPictureText(db: StudyDB, lectureId: string, slideIndex: number, elementId: string, text: string): Promise<void> {
  await db.transaction('rw', [db.lectures, db.slides], async () => {
    const lecture = await db.lectures.get(lectureId);
    const row = await db.slides.get([lectureId, slideIndex]);
    if (!lecture || !row) throw new Error('슬라이드(페이지)를 찾을 수 없습니다.');
    const updated = withPictureText(row, elementId, text);
    if (updated === row) throw new Error('그 그림은 이 슬라이드(페이지)에 없습니다.');
    await db.slides.put({ ...updated, lectureId });
    const slides = await loadSlides(db, lectureId);
    await db.lectures.put({ ...lecture, updatedAt: Date.now(), report: keepLimitations(lecture.report, rebuildReport(lecture.report, slides)) });
  });
}
