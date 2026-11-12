import type { AiState } from '@/app/ai';

/** Why AI cannot answer right now, as one Korean sentence for the AI screens; undefined when it can. */
export function aiBlocker(ai: AiState): string | undefined {
  switch (ai.phase) {
    case 'loading':
      return 'AI 서버를 확인하는 중…';
    case 'unavailable':
      return '이 앱 사본에서는 AI를 쓸 수 없습니다.';
    case 'ready':
      return ai.status.state === 'ready' ? undefined : (ai.status.reasons[0] ?? 'AI가 꺼져 있습니다.');
  }
}
