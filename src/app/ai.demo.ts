import type { AiReply, AiTask } from '@/core/tutor/contract';
import type { ActionResult, AiState, ChatGptAction, ChatGptModelsResult } from './ai';

const UNAVAILABLE: AiState = { phase: 'unavailable' };
const WHY = import.meta.env.MODE === 'sites' ? '배포된 사이트에서는 AI 기능을 쓸 수 없습니다. 내 컴퓨터에서 pnpm local로 실행하세요.' : '데모에서는 AI 기능을 쓸 수 없습니다.';

export function refreshAi(): Promise<void> {
  return Promise.resolve();
}

export function chatGptAction(_action: ChatGptAction): Promise<ActionResult> {
  return Promise.resolve({ ok: false, error: WHY });
}

export function connectChatGpt(_o: { account: 'current' | 'other'; forceConsent: boolean }): Promise<ActionResult> {
  return Promise.resolve({ ok: false, error: WHY });
}

export function loadChatGptModels(): Promise<ChatGptModelsResult> {
  return Promise.resolve({ ok: false, error: WHY });
}

export function askAi(_task: AiTask): Promise<AiReply> {
  return Promise.resolve({ ok: false, code: 'unavailable', message: WHY });
}

export function useAiServer(): AiState {
  return UNAVAILABLE;
}
