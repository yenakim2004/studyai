import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { chatGptAction, connectChatGpt, createChatGptPairing, installChatGptFile, loadChatGptModels, refreshAi, useAiServer, type ActionResult } from '@/app/ai';
import { useToast } from '@/app/toast';
import { noticeSentence, PAUSE_SENTENCE } from '@/core/chatgpt/messages';
import type { AiStatus, ChatGptModel } from '@/core/tutor/contract';
import { Button, Callout, Field, Select, Spinner } from '@/ui/primitives';

const STATE_LABEL: Record<AiStatus['state'], { text: string; cls: string }> = {
  off: { text: '꺼짐', cls: 'bg-sunken text-ink-2' },
  ready: { text: '사용 가능', cls: 'bg-ok-soft text-ok' },
  paused: { text: '멈춤', cls: 'bg-bad-soft text-bad' },
};

/** Settings → AI. ChatGPT is the only engine. No dollar figure appears here: the plan has no per-answer price. */
export function ChatGptPanel() {
  const ai = useAiServer();
  useEffect(() => {
    void refreshAi();
  }, []);

  if (ai.phase === 'loading') return <Spinner label="AI 서버를 찾는 중" />;
  if (ai.phase === 'unavailable') {
    return (
      <Callout tone="info" title="이 사본에는 AI가 없습니다">
        <p>AI 서버가 없어서 아무것도 다른 곳으로 보내지 않습니다. 읽기, 검색, 플래시카드, 노트, 모의시험, 백업은 AI 없이 모두 됩니다.</p>
        <p className="mt-2">AI 튜터는 ChatGPT 연결 서버가 설정된 개인 사이트 또는 내 컴퓨터에서 pnpm local로 실행한 StudyAI에서 쓸 수 있습니다.</p>
      </Callout>
    );
  }
  return <Connection status={ai.status} />;
}

function Connection({ status }: { status: AiStatus }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const c = status.connection;

  const label = STATE_LABEL[status.state];

  const run = async (key: string, fn: () => Promise<ActionResult>, done?: string) => {
    setBusy(key);
    setError(undefined);
    const r = await fn();
    setBusy(undefined);
    if (!r.ok) setError(r.error);
    else if (done) toast.show(done, 'ok');
  };
  const connect = (key: string, account: 'current' | 'other', forceConsent: boolean) => run(key, () => status.connectVia === 'file' ? createChatGptPairing({ account, forceConsent }) : connectChatGpt({ account, forceConsent }));
  const forget = () => run('forget', () => chatGptAction('forget'), '저장된 ChatGPT 계정 정보를 지웠습니다.');

  return (
    <section aria-labelledby="chatgpt-h" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="chatgpt-h" className="font-semibold">
          ChatGPT 플랜 연결
        </h3>
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ${label.cls}`}>{label.text}</span>
        {c.kind === 'connected' && c.model && <span className="text-sm text-ink-2">{c.model.displayName}</span>}
      </div>
      {status.reasons.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          {status.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="max-w-prose text-sm text-ink-2">
        <p>ChatGPT 플랜으로 답변합니다. StudyAI는 달러 비용을 계산하지 않습니다. 사용량과 한도는 ChatGPT에서 확인하세요.</p>
        <p className="mt-1">플랜의 사용 한도는 이 앱을 포함해 같은 계정을 쓰는 모든 앱이 함께 씁니다.</p>
      </div>

      {!status.signInAvailable && c.kind !== 'connected' && (
        <Callout tone="info" title="이 서버에서는 ChatGPT에 연결할 수 없습니다">
          <p>ChatGPT 연결은 내 컴퓨터에서 pnpm local로 실행한 StudyAI(http://127.0.0.1 주소)에서만 할 수 있습니다.</p>
        </Callout>
      )}

      {status.notice && (
        <p role="status" className="max-w-prose text-sm">
          {noticeSentence(status.notice)}
        </p>
      )}

      {status.connectVia === 'file' && status.signInAvailable && (
        <div className="max-w-prose rounded-lg border border-line p-4 text-sm">
          <p className="font-medium">내 컴퓨터에서 로그인하고 이 사이트에 연결합니다.</p>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li>아래 연결 버튼을 눌러 요청 파일을 내려받습니다. 요청은 10분 동안 유효합니다.</li>
            <li><a href="/downloads/studyai-connect.mjs" download className="text-accent underline">연결 도구 내려받기</a>를 누르고 요청 파일과 같은 폴더에 저장합니다.</li>
            <li>Node.js 22 이상이 설치된 컴퓨터의 터미널에서 다음 명령을 실행합니다. 마지막 파일 이름은 내려받은 요청 파일 이름으로 바꾸세요.<code className="mt-1 block overflow-x-auto rounded bg-sunken p-2">node studyai-connect.mjs studyai-pairing-XXXXXXXX.json</code></li>
            <li>터미널에 나온 주소에서 ChatGPT에 로그인한 뒤, 도구가 만든 연결 결과 파일을 아래에 올립니다.</li>
          </ol>
          <p className="mt-3 text-ink-2">요청 파일은 본인의 이 사이트에서 직접 내려받은 것만 사용하세요. 연결 결과는 암호화되어 있으며 이 사이트만 열 수 있습니다.</p>
          {status.pendingUntil && <p role="status" className="mt-2">연결 파일을 기다리는 중 · {new Date(status.pendingUntil).toLocaleTimeString('ko-KR')}까지</p>}
          <label className="mt-3 block font-medium" htmlFor="chatgpt-connection-file">암호화된 연결 결과 파일</label>
          <input id="chatgpt-connection-file" className="mt-1 block w-full" type="file" accept=".json,application/json" disabled={busy !== undefined} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void run('install', () => installChatGptFile(file), 'ChatGPT 연결이 완료되었습니다.');
          }} />
        </div>
      )}

      {c.kind === 'disconnected' && status.signInAvailable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" data-oai-siwc-button disabled={busy !== undefined} onClick={() => void connect('connect', 'current', false)}>
            {status.connectVia === 'file' ? 'ChatGPT 연결 요청 파일 받기' : 'ChatGPT로 계속하기'}
          </Button>
          {c.registered && (
            <>
              <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void connect('other', 'other', false)}>
                다른 ChatGPT 계정 사용
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void forget()}>
                저장된 계정 정보 지우기
              </Button>
            </>
          )}
        </div>
      )}

      {c.kind === 'plan-disabled' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">연결된 계정: {c.email ?? '(이메일 없음)'}. ChatGPT 플랜 사용은 꺼져 있습니다.</p>
          {status.signInAvailable && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy !== undefined} onClick={() => void connect('consent', 'current', true)}>
                ChatGPT 플랜 사용 허용
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void connect('other', 'other', false)}>
                다른 ChatGPT 계정 사용
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void forget()}>
                저장된 계정 정보 지우기
              </Button>
            </div>
          )}
        </div>
      )}

      {c.kind === 'connected' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">연결된 계정: {c.email ?? '(이메일 없음)'}</p>
          <ModelPicker selected={c.model} />
          {c.pause && (
            <Callout tone="warn" title="ChatGPT 사용이 멈춰 있습니다">
              <p>{PAUSE_SENTENCE[c.pause.code]}</p>
              <p className="mt-2 flex flex-wrap items-center gap-3">
                <a className="inline-flex items-center gap-1 text-accent underline underline-offset-2" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">
                  ChatGPT 열기 <ExternalLink className="size-3.5" aria-hidden />
                </a>
                <Button size="sm" disabled={busy !== undefined} onClick={() => void run('resume', () => chatGptAction('resume'), '다시 시작했습니다.')}>
                  다시 시작
                </Button>
              </p>
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy !== undefined} onClick={() => void run('disconnect', () => chatGptAction('disconnect'), 'ChatGPT 연결을 해제했습니다.')}>
              연결 해제
            </Button>
            {status.signInAvailable && (
              <>
                <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void connect('reauth', 'current', false)}>
                  다시 로그인
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => void connect('other', 'other', false)}>
                  다른 ChatGPT 계정 사용
                </Button>
              </>
            )}
          </div>
          <p className="max-w-prose text-[13px] text-ink-3">다른 계정으로 로그인해도 새 로그인이 확인되기 전까지는 지금 연결이 그대로 유지됩니다.</p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}

/** The connected account's own catalog, loaded from OpenAI when this panel opens. */
function ModelPicker({ selected }: { selected: ChatGptModel | null }) {
  const [models, setModels] = useState<ChatGptModel[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(undefined);
    const r = await loadChatGptModels();
    setBusy(false);
    if (r.ok) setModels(r.models);
    else setError(r.error);
  };
  useEffect(() => {
    void load();
  }, []);

  const choose = async (slug: string) => {
    setBusy(true);
    setError(undefined);
    const r = await chatGptAction({ model: slug });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  return (
    <div className="max-w-md">
      <Field label="ChatGPT 모델" htmlFor="chatgpt-model" hint="이 계정에서 OpenAI가 알려 준 모델만 보입니다. 고르지 않으면 목록의 첫 모델을 씁니다.">
        <Select id="chatgpt-model" value={selected?.slug ?? ''} disabled={busy || !models || models.length === 0} onChange={(e) => void choose(e.target.value)}>
          {!selected && <option value="">{models ? '모델을 고르세요' : '모델 목록을 불러오는 중…'}</option>}
          {(models ?? (selected ? [selected] : [])).map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.displayName}
            </option>
          ))}
        </Select>
      </Field>
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
    </div>
  );
}
