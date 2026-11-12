import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { AiReply, AiStatus, AiTask, ChatGptModel } from '@/core/tutor/contract';

/** Same-origin AI transport for the local Worker and the private Sites server. Static builds replace this module. */

export type AiState = { phase: 'loading' } | { phase: 'unavailable' } | { phase: 'ready'; status: AiStatus };

let state: AiState = { phase: 'loading' };
const listeners = new Set<() => void>();
function set(next: AiState): void {
  state = next;
  for (const l of listeners) l();
}

interface Json {
  status: number;
  body: unknown;
}

/** A same-origin JSON request. Returns undefined when the answer is not JSON from this server (e.g. a static file server). */
async function call(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}): Promise<Json | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      signal: ctl.signal,
      ...(init.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : {}),
    });
    if (!/^application\/json/i.test(res.headers.get('content-type') ?? '')) return undefined;
    return { status: res.status, body: await res.json() };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const messageOf = (body: unknown, fallback: string): string => {
  const m = (body as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : fallback;
};

/** A static host or inaccessible API is shown as unavailable. */
async function readStatus(): Promise<void> {
  const r = await call('/api/status');
  set(r?.status === 200 ? { phase: 'ready', status: r.body as AiStatus } : { phase: 'unavailable' });
}

let inflight: Promise<void> | undefined;

export function refreshAi(): Promise<void> {
  inflight ??= readStatus().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

export type ActionResult = { ok: true } | { ok: false; error: string };
export type ChatGptAction = 'disconnect' | 'forget' | 'resume' | { model: string };

const NO_SERVER = 'StudyAI 서버에 연결하지 못했습니다. 사이트를 새로고침하세요. 로컬 실행 중이라면 서버가 켜져 있는지 확인하세요.';

const PairingDownloadSchema = z.object({ ok: z.literal(true), request: z.object({ v: z.literal('studyai-pairing/1'), pairingId: z.uuid(), expiresAt: z.number() }).passthrough() });
const ConnectionFileSchema = z.object({
  v: z.literal('studyai-connection/1'), pairingId: z.uuid(),
  epk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }).strict(),
  iv: z.string(), ct: z.string(),
}).strict();

export async function createChatGptPairing(o: { account: 'current' | 'other'; forceConsent: boolean }): Promise<ActionResult> {
  const r = await call('/api/chatgpt/pairing', { method: 'POST', body: o });
  if (!r) return { ok: false, error: NO_SERVER };
  const parsed = PairingDownloadSchema.safeParse(r.body);
  if (!parsed.success) return { ok: false, error: messageOf(r.body, '연결 요청 파일을 만들지 못했습니다.') };
  const url = URL.createObjectURL(new Blob([JSON.stringify(parsed.data.request)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `studyai-pairing-${parsed.data.request.pairingId.slice(0, 8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  await refreshAi();
  return { ok: true };
}

export async function installChatGptFile(file: File): Promise<ActionResult> {
  if (file.size > 65_536) return { ok: false, error: '연결 파일은 64 KiB 이하여야 합니다.' };
  let raw: unknown;
  try { raw = JSON.parse(await file.text()); } catch { return { ok: false, error: '연결 파일을 읽지 못했습니다.' }; }
  const parsed = ConnectionFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: '로그인 도구가 만든 연결 결과 파일을 선택하세요. 요청 파일은 올릴 수 없습니다.' };
  const r = await call('/api/chatgpt/install', { method: 'POST', body: parsed.data, timeoutMs: 60_000 });
  await refreshAi();
  if (!r) return { ok: false, error: '연결 결과를 받지 못해 서버 상태를 다시 확인했습니다. 화면의 계정 연결 상태를 확인하세요.' };
  return r.status === 200 ? { ok: true } : { ok: false, error: messageOf(r.body, 'ChatGPT 연결을 확인하지 못했습니다.') };
}

/** Disconnect, forget the saved account, resume after a pause, or choose a model. The server validates everything again. */
export async function chatGptAction(action: ChatGptAction): Promise<ActionResult> {
  const [path, body] =
    action === 'disconnect' ? ['/api/chatgpt/disconnect', { forget: false }] : action === 'forget' ? ['/api/chatgpt/disconnect', { forget: true }] : action === 'resume' ? ['/api/chatgpt/resume', {}] : ['/api/chatgpt/model', { model: action.model }];
  const r = await call(path, { method: 'POST', body });
  if (!r) return { ok: false, error: NO_SERVER };
  await refreshAi();
  return (r.body as { ok?: unknown } | null)?.ok === true ? { ok: true } : { ok: false, error: messageOf(r.body, '요청을 처리하지 못했습니다.') };
}

/**
 * Starts ChatGPT sign-in and leaves for OpenAI in this same tab. A popup opened after an awaited request loses the click's
 * user activation, and the app's opener policy would cut it off anyway. The return is a fresh load of /settings.
 * Resolves only when the server refuses, with a Korean sentence.
 */
export async function connectChatGpt(o: { account: 'current' | 'other'; forceConsent: boolean }): Promise<ActionResult> {
  const r = await call('/api/chatgpt/start', { method: 'POST', body: o });
  if (!r) return { ok: false, error: NO_SERVER };
  const b = r.body as { ok?: boolean; authorizeUrl?: unknown } | null;
  if (b?.ok && typeof b.authorizeUrl === 'string' && /^https?:\/\//.test(b.authorizeUrl)) {
    window.location.assign(b.authorizeUrl);
    return { ok: true };
  }
  return { ok: false, error: messageOf(r.body, 'ChatGPT 연결을 시작하지 못했습니다.') };
}

export type ChatGptModelsResult = { ok: true; models: ChatGptModel[]; selected: string | null } | { ok: false; error: string };

/** The connected account's own model catalog. Nothing is hardcoded: the list is whatever OpenAI returns for this account. */
export async function loadChatGptModels(): Promise<ChatGptModelsResult> {
  const r = await call('/api/chatgpt/models', { timeoutMs: 60_000 });
  if (!r) return { ok: false, error: NO_SERVER };
  const b = r.body as { ok?: boolean; models?: unknown; selected?: unknown } | null;
  await refreshAi();
  if (b?.ok && Array.isArray(b.models)) {
    const models = b.models.filter((m): m is ChatGptModel => !!m && typeof (m as ChatGptModel).slug === 'string' && typeof (m as ChatGptModel).displayName === 'string');
    return { ok: true, models, selected: typeof b.selected === 'string' ? b.selected : null };
  }
  return { ok: false, error: messageOf(r.body, '모델 목록을 불러오지 못했습니다.') };
}

/** The server's own ChatGPT deadline is 170 s, so it always answers first with a clean timeout. */
const ASK_TIMEOUT_MS = 180_000;

/** Sends one structured task. Never throws; a refusal or failure comes back with a Korean message. */
export async function askAi(task: AiTask): Promise<AiReply> {
  const r = await call('/api/ai/ask', { method: 'POST', body: task, timeoutMs: ASK_TIMEOUT_MS });
  if (!r) return { ok: false, code: 'network', message: 'AI 서버에 연결하지 못했습니다. 서버가 답하지 않았다면 슬라이드는 어디에도 보내지지 않았습니다.' };
  void refreshAi(); // keeps the pause and connection state current; failures are harmless
  const b = r.body as Partial<AiReply> | null;
  if (b && typeof b === 'object' && typeof b.ok === 'boolean') return b as AiReply;
  return { ok: false, code: 'server-error', message: 'AI 서버가 예상하지 못한 방식으로 답했습니다.' };
}

export function useAiServer(): AiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
