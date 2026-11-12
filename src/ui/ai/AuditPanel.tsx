import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useSetting } from '@/app/data';
import { AUDIT_MAX_QUESTIONS, auditFindings, auditQuestions, findingText, parseAudit, type AuditFinding, type AuditQuestion } from '@/core/study/audit';
import { Button } from '@/ui/primitives';
import { aiBlocker } from '@/ui/ai/blocker';
import { AI_DESTINATION as dest } from '@/ui/ai/destination';

interface Checked {
  /** What was sent, so a finding can still be matched to its marking point after other points were removed. */
  sent: AuditQuestion[];
  findings: AuditFinding[];
}

/**
 * An optional check, by the AI, that every marking point answers something the question explicitly asks. The device has already
 * counted what each question asks for; this reads the meaning. What is sent (questions, marking points and model answers, never
 * your slides) is shown first, it costs one request, and a point it flags can be removed here (the question then loses those marks).
 */
export function AuditPanel({ questions, onRemove }: { questions: AuditQuestion[]; onRemove: (n: number, point: number) => void }) {
  const ai = useAiServer();
  const [consent, setConsent] = useSetting<string>(dest.consentKey);
  useEffect(() => {
    void refreshAi();
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState<Checked | undefined>();
  const blocker = aiBlocker(ai);
  const usable = blocker === undefined;

  const toSend = useMemo(() => auditQuestions(questions), [questions]);
  const writtenCount = useMemo(() => questions.filter((q) => q.rubric.length > 0 && q.type !== 'mcq' && q.type !== 'truefalse').length, [questions]);

  // A new pack, or a question that was edited, starts a fresh check.
  const signature = useMemo(() => JSON.stringify(questions.map((q) => [q.n, q.prompt])), [questions]);
  useEffect(() => {
    setChecked(undefined);
    setError(undefined);
  }, [signature]);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setChecked(undefined);
    try {
      const reply = await askAi({ task: 'audit', questions: toSend });
      if (!reply.ok) setError(reply.message);
      else {
        const verdicts = parseAudit(reply.text);
        if (!verdicts) setError('AI의 답을 읽지 못했습니다.');
        else setChecked({ sent: toSend, findings: auditFindings(verdicts, toSend) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '점검하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  // The findings that still apply: a point that was removed has no finding left, and the others keep their place by wording.
  const shown = useMemo(() => {
    if (!checked) return [];
    const now = new Map(questions.map((q) => [q.n, q]));
    return checked.findings.flatMap((f) => {
      const q = now.get(f.n);
      if (!q) return [];
      if (f.point === undefined) return [{ f, point: undefined as number | undefined, removable: false }];
      const at = q.rubric.findIndex((r) => r.text === f.pointText);
      return at < 0 ? [] : [{ f, point: at + 1, removable: q.rubric.length > 1 }];
    });
  }, [checked, questions]);
  const checkedCount = checked?.sent.length ?? 0;

  if (writtenCount === 0) return null;
  return (
    <section aria-label="AI의 채점 기준 점검" className="rounded-[var(--radius-panel)] border border-rule bg-sunken/40 p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <Sparkles className="size-4" aria-hidden /> AI로 채점 기준 점검하기(선택)
      </h3>
      <p className="mt-1 max-w-prose text-[13px] text-ink-3">
        위의 점검은 문제마다 요구하는 개수를 셉니다. AI는 의미를 읽습니다. 문제 자체가 모든 채점 기준을 요구하는지 봅니다. 문제에서 찾을 수 없는 기준은 군더더기이거나 다른 문제의 기준입니다. 요청 한 번으로
        {writtenCount > AUDIT_MAX_QUESTIONS ? ` 처음 ${AUDIT_MAX_QUESTIONS}개의 서술형 문제를 봅니다` : ' 서술형 문제를 봅니다'}.
      </p>
      <details className="mt-2 text-[13px] text-ink-2">
        <summary className="cursor-pointer">{dest.sentTo}에 보낼 내용</summary>
        <div className="mt-1 max-h-40 overflow-y-auto rounded-[var(--radius-control)] border border-rule bg-surface p-2">
          <p>아래 텍스트만 보냅니다: 문제, 채점 기준, 모범 답안. 슬라이드, 파일, 계정 정보는 보내지 않습니다.</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {toSend.map((q) => (
              <li key={q.n}>
                {q.prompt.slice(0, 200)}
                {q.prompt.length > 200 ? '…' : ''} <span className="text-ink-3">(채점 기준 {q.rubric.length}개)</span>
              </li>
            ))}
          </ol>
        </div>
      </details>

      {!usable ? (
        <p className="mt-2 text-sm text-ink-2">
          {blocker}{' '}
          {ai.phase === 'ready' && <Link to="/settings" className="text-accent underline underline-offset-2">설정 → AI 열기</Link>}
        </p>
      ) : (
        <div className="mt-3">
          {!consent && (
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" onChange={(e) => e.target.checked && void setConsent(new Date().toISOString().slice(0, 10))} />
              <span>{dest.consent}</span>
            </label>
          )}
          <Button size="sm" disabled={busy || !consent || toSend.length === 0} onClick={() => void run()}>
            {busy ? '점검하는 중…' : 'AI로 점검'}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}

      {checked && (
        <div className="mt-4 border-t border-rule pt-3" aria-label="AI가 찾은 것">
          <p className="text-sm">
            {checked.findings.length === 0 ? `AI가 읽은 문제 ${checkedCount}개에서 알릴 것을 찾지 못했습니다. 모든 채점 기준을 문제가 요구합니다.` : shown.length === 0 ? 'AI가 표시한 것을 모두 처리했습니다.' : `AI가 문제 ${checkedCount}개를 읽고 살펴볼 것 ${shown.length}개를 찾았습니다. AI도 틀릴 수 있으니 직접 판단하세요.`}
          </p>
          {shown.length > 0 && (
            <ul className="mt-2 flex flex-col gap-2 text-[13px]">
              {shown.map(({ f, point, removable }, i) => (
                <li key={`${f.n}-${f.point ?? 'q'}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <span>
                    <span className="font-medium text-ink">문제 #{f.n}:</span> {findingText(f, point)}
                  </span>
                  {point !== undefined && (
                    <Button size="sm" variant="secondary" disabled={!removable} onClick={() => onRemove(f.n, point - 1)} aria-label={`문제 ${f.n}의 채점 기준 ${point} 삭제`}>
                      이 기준 삭제
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shown.some((s) => s.point !== undefined) && <p className="mt-2 text-[13px] text-ink-3">기준을 지우면 그 점수도 문제 배점에서 빠지므로, 배점이 문제가 실제로 요구하는 만큼으로 유지됩니다.</p>}
        </div>
      )}
    </section>
  );
}
