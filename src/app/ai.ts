import { useSyncExternalStore } from 'react';
import type { AiReply, AiStatus, AiTask, ChatGptModel } from '@/core/tutor/contract';

/**
 * The browser's only connection to the AI server (the local Worker). Everything is same-origin: the page's CSP forbids any
 * other address. The server is optional: when the app is opened without it (plain dev server, a hosted copy), every AI
 * feature says so and the rest of the app works exactly as before. Nothing here is called until an AI screen is opened.
 * There is no sign-in to StudyAI itself: the local server trusts the app opened at its exact 127.0.0.1 address.
 */

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

/** Reads the status. Anything but a status from this server (no server, a hosted copy, a wrong address) means no AI here. */
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

const NO_SERVER = 'StudyAI 서버에 연결하지 못했습니다. pnpm local로 실행한 창이 켜져 있는지 확인하세요.';

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
