import { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, ShieldCheck, Upload } from 'lucide-react';
import { applyBackup, BackupError, exportBackup, readBackup, type ImportMode, type ParsedBackup } from '@/core/backup/backup';
import { getDb } from '@/core/db/db';
import { useAllLectures, useCourses } from '@/app/data';
import { useTheme, type ThemeChoice } from '@/app/theme';
import { useToast } from '@/app/toast';
import { ChatGptPanel } from '@/ui/ai/ChatGptPanel';
import { Button, Callout, Dialog, formatBytes, Spinner } from '@/ui/primitives';

const db = getDb();

export function SettingsPage() {
  const { choice, setChoice } = useTheme();
  const courses = useCourses();
  const lectures = useAllLectures();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState<string | undefined>();
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<{ backup: ParsedBackup; name: string } | undefined>();
  const [mode, setMode] = useState<ImportMode>('merge');
  const [applying, setApplying] = useState(false);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});

  const refreshStorage = async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    setStorage({ usage: est?.usage, quota: est?.quota, persisted });
  };
  useEffect(() => void refreshStorage(), [courses, lectures]);

  const doExport = async () => {
    try {
      setExporting('시작하는 중');
      const blob = await exportBackup(db, (p) => setExporting(`${p.label} (${p.done}/${p.total})`), 'studyai 0.1');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `studyai-backup-${new Date().toISOString().slice(0, 10)}.studyai.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.show(`백업을 저장했습니다(${formatBytes(blob.size)}). 이미 쓰는 클라우드 저장소처럼 안전한 곳에 보관하세요.`, 'ok');
    } catch (err) {
      toast.show(err instanceof Error ? `백업하지 못했습니다: ${err.message}` : '백업하지 못했습니다.', 'error');
    } finally {
      setExporting(undefined);
    }
  };

  const choose = async (file: File) => {
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Yield once so the spinner paints before the (synchronous) validation runs.
      await new Promise((r) => setTimeout(r, 30));
      setPreview({ backup: readBackup(bytes), name: file.name });
      setMode('merge');
    } catch (err) {
      toast.show(err instanceof BackupError ? err.message : '그 파일을 읽지 못했습니다.', 'error');
    } finally {
      setReading(false);
    }
  };

  const doRestore = async () => {
    if (!preview) return;
    setApplying(true);
    try {
      const s = await applyBackup(db, preview.backup, mode);
      toast.show(`복원했습니다: 강의 ${s.lecturesAdded + s.lecturesReplaced}개(슬라이드 ${s.slides}장), 과목 ${s.coursesAdded + s.coursesUpdated}개${s.lecturesSkipped ? `, 바뀌지 않은 강의 ${s.lecturesSkipped}개` : ''}.`, 'ok');
      setPreview(undefined);
    } catch (err) {
      toast.show(err instanceof Error ? `복원하지 못했습니다: ${err.message}` : '복원하지 못했습니다.', 'error');
    } finally {
      setApplying(false);
    }
  };

  const themes: [ThemeChoice, string][] = [
    ['system', '기기 설정 따르기'],
    ['light', '밝게'],
    ['dark', '어둡게'],
  ];
  const slideTotal = (lectures ?? []).reduce((n, l) => n + l.slideCount, 0);
  const b = preview?.backup;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">설정과 백업</h1>

      <section className="mt-8" aria-labelledby="appearance-h">
        <h2 id="appearance-h" className="text-lg font-semibold">
          화면
        </h2>
        <fieldset className="mt-3">
          <legend className="sr-only">테마</legend>
          <div className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-rule-strong">
            {themes.map(([id, label]) => (
              <label key={id} className={`inline-flex min-h-10 cursor-pointer items-center px-3.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${choice === id ? 'bg-accent-soft font-medium text-ink' : 'bg-surface text-ink-2 hover:bg-sunken'}`}>
                <input type="radio" name="theme" value={id} checked={choice === id} onChange={() => setChoice(id)} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="mt-10" aria-labelledby="backup-h">
        <h2 id="backup-h" className="text-lg font-semibold">
          백업과 복원
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          라이브러리는 이 브라우저에만 있습니다. 사이트 데이터를 지우거나, 브라우저나 기기를 바꾸거나, 다시 설치하면 사라집니다. 백업은 과목, 강의, 슬라이드, 이미지, 원본 강의 파일을 담은 파일 하나입니다.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" onClick={() => void doExport()} disabled={!!exporting || (courses?.length ?? 0) === 0}>
            <Download className="size-4" aria-hidden /> 백업 내보내기
          </Button>
          <Button onClick={() => fileInput.current?.click()} disabled={reading}>
            <Upload className="size-4" aria-hidden /> 백업에서 복원
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.studyai.zip,application/zip"
            className="sr-only"
            aria-label="백업 파일 고르기"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void choose(f);
              e.target.value = '';
            }}
          />
        </div>
        {exporting && (
          <p className="mt-3">
            <Spinner label={`내보내는 중: ${exporting}`} />
          </p>
        )}
        {reading && (
          <p className="mt-3">
            <Spinner label="백업을 확인하는 중" />
          </p>
        )}
      </section>

      <section className="mt-10" aria-labelledby="storage-h">
        <h2 id="storage-h" className="text-lg font-semibold">
          이 기기
        </h2>
        <dl className="mt-3 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule text-sm sm:grid-cols-3">
          <div className="bg-surface px-4 py-3">
            <dt className="text-[13px] text-ink-3">과목과 강의</dt>
            <dd className="text-lg font-semibold">
              과목 {courses?.length ?? 0}개, 강의 {lectures?.length ?? 0}개
            </dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="text-[13px] text-ink-3">저장된 슬라이드</dt>
            <dd className="text-lg font-semibold">{slideTotal}</dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="text-[13px] text-ink-3">사용 공간</dt>
            <dd className="text-lg font-semibold">{storage.usage !== undefined ? formatBytes(storage.usage) : '알 수 없음'}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-2">
          <HardDrive className="size-4" aria-hidden />
          {storage.persisted ? (
            <span>브라우저가 이 데이터를 자동으로 지우지 않기로 했습니다.</span>
          ) : (
            <>
              <span>기기 공간이 부족하면 브라우저가 이 데이터를 지울 수 있습니다.</span>
              <Button
                size="sm"
                onClick={async () => {
                  const ok = await navigator.storage?.persist?.();
                  toast.show(ok ? '자동 정리에서 보호됩니다.' : '브라우저가 거절했습니다. 대신 정기적으로 백업하세요.', ok ? 'ok' : 'info');
                  void refreshStorage();
                }}
              >
                브라우저에 보관 요청
              </Button>
            </>
          )}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="ai-h">
        <h2 id="ai-h" className="text-lg font-semibold">
          AI 학습 도우미
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          선택 기능입니다. 앱의 다른 기능은 AI 없이도 모두 되고, AI가 꺼지거나 멈춰도 계속 됩니다. AI는 스스로 움직이지 않습니다. 보내기를 눌렀을 때만 보내며, 무엇을 보내는지 먼저 정확히 보여 줍니다.
        </p>
        <div className="mt-4">
          <ChatGptPanel />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="privacy-h">
        <h2 id="privacy-h" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5 text-ok" aria-hidden /> 개인정보
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>PowerPoint와 PDF 파일은 브라우저 안에서 읽고 업로드하지 않습니다.</li>
          <li>계정, 분석, 추적이 없습니다. 외부 글꼴이나 외부 서비스에서 아무것도 불러오지 않습니다.</li>
          <li>내가 만든 백업 파일만 이 브라우저를 벗어납니다.</li>
        </ul>
      </section>

      <Dialog
        open={!!preview}
        onClose={() => !applying && setPreview(undefined)}
        wide
        title="백업에서 복원"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(undefined)} disabled={applying}>
              취소
            </Button>
            <Button variant={mode === 'replace' ? 'danger' : 'primary'} onClick={() => void doRestore()} disabled={applying}>
              {applying ? '복원하는 중' : mode === 'replace' ? '내 라이브러리 바꾸기' : '내 라이브러리에 합치기'}
            </Button>
          </>
        }
      >
        {b && preview && (
          <div className="flex flex-col gap-4 text-sm">
            <p>
              <span className="font-medium">{preview.name}</span>은(는) {new Date(b.manifest.createdAt).toLocaleString('ko-KR')}에 만든 백업입니다. 확인을 마쳤고 안전하게 읽을 수 있습니다.
            </p>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-4">
              {(
                [
                  ['과목', b.manifest.counts.courses],
                  ['강의', b.manifest.counts.lectures],
                  ['슬라이드', b.manifest.counts.slides],
                  ['이미지', b.manifest.counts.media],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-surface px-3 py-2">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {b.warnings.length > 0 && (
              <Callout tone="warn" title="이 백업에 대한 참고">
                <ul className="list-disc space-y-0.5 pl-4">
                  {b.warnings.slice(0, 6).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="font-medium">어떻게 복원할까요?</legend>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-rule p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} className="mt-1 accent-[var(--accent)]" />
                <span>
                  <span className="block font-medium">합치기(권장)</span>
                  <span className="text-ink-2">없는 것을 더하고, 백업에 더 새 버전이 있는 강의를 업데이트합니다. 아무것도 지우지 않습니다.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-rule p-3 has-[:checked]:border-bad has-[:checked]:bg-bad-soft">
                <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-1 accent-[var(--bad)]" />
                <span>
                  <span className="block font-medium">전부 바꾸기</span>
                  <span className="text-ink-2">이 기기의 현재 라이브러리를 먼저 지운 뒤 백업을 복원합니다. 고르기 전에 백업을 내보내세요.</span>
                </span>
              </label>
            </fieldset>
          </div>
        )}
      </Dialog>
    </div>
  );
}
