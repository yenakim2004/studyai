import type { ChatGptNotice, ChatGptPauseCode, SignInOutcome } from '../tutor/contract';
import type { ResponsesFailure } from './responses';

/**
 * Every fixed Korean sentence the ChatGPT connection can show, and the HTTP status of every reply code. One table each, so
 * the callback page, Settings and the tutor cannot drift apart, and a new code cannot fall through to a 500 or a 401.
 * No sentence carries upstream text.
 */

/** Every reply code with its HTTP status and its one Korean sentence. */
export const CHATGPT_REPLY = {
  'chatgpt-signin-required': { status: 403, message: 'ChatGPT가 연결되어 있지 않거나 로그인이 만료되었습니다. 설정 → AI에서 ChatGPT를 다시 연결하세요.' },
  'chatgpt-plan-disabled': { status: 403, message: 'ChatGPT 플랜 사용이 허용되지 않았습니다. 설정 → AI에서 "ChatGPT 플랜 사용 허용"을 누르세요.' },
  'chatgpt-not-configured': { status: 503, message: '이 서버에는 ChatGPT 연결 설정이 없습니다. 내 컴퓨터에서 pnpm local로 실행한 StudyAI에서만 쓸 수 있습니다.' },
  'chatgpt-paused': { status: 429, message: 'ChatGPT 사용 한도 때문에 멈춰 있습니다. ChatGPT 설정에서 사용량을 확인한 뒤 설정 → AI에서 "다시 시작"을 누르세요.' },
  'chatgpt-usage-limit': { status: 429, message: 'ChatGPT 플랜의 사용 한도에 도달했습니다. 한도가 풀린 뒤 설정 → AI에서 "다시 시작"을 누르세요.' },
  'chatgpt-not-eligible': { status: 403, message: '이 ChatGPT 계정은 외부 앱에서 플랜을 사용할 수 없습니다. ChatGPT 플랜과 설정을 확인하세요.' },
  'chatgpt-rate-limited': { status: 429, message: 'ChatGPT가 요청이 너무 많다고 답했습니다. 잠시 뒤 다시 보내세요.' },
  'chatgpt-forbidden': { status: 403, message: 'ChatGPT가 이 요청을 허용하지 않았습니다. 지역이나 계정 정책 때문일 수 있습니다.' },
  'chatgpt-unavailable': { status: 503, message: 'ChatGPT에 지금 연결할 수 없습니다. 잠시 뒤 다시 보내세요. 연결은 그대로 유지됩니다.' },
  'chatgpt-timeout': { status: 504, message: 'ChatGPT 답변이 제한 시간 안에 끝나지 않았습니다. 다시 보내거나 질문을 줄여 보세요.' },
  'chatgpt-aborted': { status: 409, message: 'ChatGPT 연결이 해제되었거나 다른 연결로 바뀌어 요청을 멈췄습니다.' },
  'chatgpt-auth-retry': { status: 503, message: 'ChatGPT 로그인 상태를 다시 확인했습니다. 같은 요청을 자동으로 다시 보내지 않았으니 한 번 더 보내세요.' },
  'chatgpt-busy': { status: 429, message: 'ChatGPT 요청이 이미 두 개 진행 중입니다. 끝난 뒤 다시 보내세요.' },
  'chatgpt-no-model': { status: 503, message: '이 ChatGPT 계정에서 사용할 수 있는 모델이 없습니다.' },
  'chatgpt-incomplete': { status: 502, message: 'ChatGPT 답변이 끝까지 완성되지 않아 버렸습니다. 다시 보내세요.' },
  'chatgpt-interrupted': { status: 502, message: 'ChatGPT 답변이 중간에 끊겨 버렸습니다. 다시 보내세요.' },
  'chatgpt-failed': { status: 502, message: 'ChatGPT가 답변을 만들지 못했습니다. 다시 보내세요.' },
  'chatgpt-rejected': { status: 502, message: 'ChatGPT가 요청을 거절했습니다.' },
  'chatgpt-unsupported': { status: 502, message: 'ChatGPT가 이 요청 형식을 지원하지 않습니다. StudyAI의 문제이니 알려 주세요.' },
  'chatgpt-too-large': { status: 502, message: 'ChatGPT 답변이 너무 길어 받지 않았습니다. 질문을 나눠 보내세요.' },
  'chatgpt-network': { status: 502, message: 'ChatGPT와 통신하지 못했습니다. 인터넷 연결을 확인하고 다시 보내세요.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ChatGptCode = keyof typeof CHATGPT_REPLY;

export function isChatGptCode(code: string): code is ChatGptCode {
  return Object.hasOwn(CHATGPT_REPLY, code);
}

/** What each Responses failure means for the reply. `auth` is resolved by the caller (refresh, then sign-in or retry). */
export const FAILURE_CODE = {
  auth: 'chatgpt-signin-required',
  'not-eligible': 'chatgpt-not-eligible',
  forbidden: 'chatgpt-forbidden',
  'usage-limit': 'chatgpt-usage-limit',
  'rate-limited': 'chatgpt-rate-limited',
  unavailable: 'chatgpt-unavailable',
  unsupported: 'chatgpt-unsupported',
  rejected: 'chatgpt-rejected',
  failed: 'chatgpt-failed',
  incomplete: 'chatgpt-incomplete',
  interrupted: 'chatgpt-interrupted',
  'invalid-response': 'chatgpt-failed',
  'too-large': 'chatgpt-too-large',
  timeout: 'chatgpt-timeout',
  aborted: 'chatgpt-aborted',
  network: 'chatgpt-network',
  redirect: 'chatgpt-network',
} as const satisfies Record<ResponsesFailure['kind'], ChatGptCode>;

export const SIGN_IN_SENTENCE = {
  connected: 'ChatGPT 연결이 완료되었습니다. 이제 튜터, 문제 생성, 채점 도우미, 채점 기준 점검이 ChatGPT 플랜으로 답합니다.',
  denied: 'ChatGPT 연결을 취소했습니다. 언제든 설정에서 다시 연결할 수 있습니다.',
  expired: '로그인 시간(10분)이 지났습니다. 설정에서 다시 시도하세요.',
  'unknown-attempt': '이 로그인 요청을 찾을 수 없습니다. 이미 사용되었거나 새 로그인으로 대체되었습니다.',
  'registration-incomplete': 'OpenAI가 앱 등록 정보를 돌려주지 않았습니다. 설정에서 다시 시도하세요.',
  'client-mismatch': 'OpenAI가 저장된 앱 등록과 다른 정보를 돌려주었습니다. 기존 연결은 그대로 유지됩니다.',
  'code-rejected': 'OpenAI가 로그인 코드를 받아들이지 않았습니다. 설정에서 다시 시도하세요.',
  'client-invalid': 'OpenAI가 저장된 앱 등록을 거부했습니다. 다시 연결해도 같은 오류가 나면 "다른 ChatGPT 계정 사용"으로 새로 등록하세요.',
  'id-token-invalid': 'OpenAI 로그인 정보를 확인하지 못했습니다. 아무것도 저장하지 않았습니다. 다시 시도하세요.',
  'account-mismatch': '저장된 계정과 다른 ChatGPT 계정으로 로그인했습니다. 기존 연결은 그대로 유지됩니다. 다른 계정을 쓰려면 "다른 ChatGPT 계정 사용"을 누르세요.',
  'plan-not-enabled': 'ChatGPT 플랜 사용 권한이 허용되지 않았습니다. 설정에서 "ChatGPT 플랜 사용 허용"을 누르면 권한을 다시 요청합니다.',
  superseded: '더 새로운 로그인이나 연결 해제가 있어 이 로그인은 적용하지 않았습니다.',
  'upstream-unavailable': 'OpenAI에 연결하지 못해 로그인을 마치지 못했습니다. 기존 연결은 그대로 유지됩니다. 잠시 뒤 다시 시도하세요.',
} as const satisfies Record<SignInOutcome, string>;

export const SESSION_ENDED_SENTENCE = {
  'refresh-rejected': 'ChatGPT 로그인이 만료되었거나 해지되었습니다. 설정에서 다시 연결하세요.',
  'invalid-client': '저장된 앱 등록이 더 이상 유효하지 않습니다. 설정에서 다시 연결하면 새로 등록합니다.',
  unreadable: '저장된 ChatGPT 로그인 정보를 읽을 수 없어 지웠습니다. 설정에서 다시 연결하세요.',
} as const satisfies Record<Extract<ChatGptNotice, { kind: 'session-ended' }>['reason'], string>;

export function noticeSentence(n: ChatGptNotice): string {
  switch (n.kind) {
    case 'sign-in':
      return SIGN_IN_SENTENCE[n.outcome];
    case 'session-ended':
      return SESSION_ENDED_SENTENCE[n.reason];
    case 'disconnected':
      if (n.remoteRevoked === null) return '이 기기에서 ChatGPT 연결을 지웠고, OpenAI 쪽 해지를 확인하는 중입니다.';
      return n.remoteRevoked ? 'ChatGPT 연결을 해제했습니다. OpenAI 쪽 로그인도 해지했습니다.' : '이 기기에서는 연결을 지웠지만 OpenAI 쪽 해지를 확인하지 못했습니다. ChatGPT 설정에서 앱 연결을 끊으세요.';
    default: {
      const exhaustive: never = n;
      return exhaustive;
    }
  }
}

export const PAUSE_SENTENCE = {
  'usage-limit': 'ChatGPT 플랜의 사용 한도에 도달해 멈췄습니다. 이 한도는 이 앱을 포함해 같은 플랜을 쓰는 모든 앱이 함께 씁니다. ChatGPT 설정 → 사용량에서 확인한 뒤 "다시 시작"을 누르세요.',
  'not-eligible': '이 계정은 외부 앱에서 ChatGPT 플랜을 쓸 수 없다고 OpenAI가 답해 멈췄습니다. 플랜을 확인한 뒤 "다시 시작"을 누르세요.',
} as const satisfies Record<ChatGptPauseCode, string>;

export const GATE_REASON = {
  'not-configured': '이 서버에는 ChatGPT 연결 설정이 없습니다. 내 컴퓨터에서 pnpm local로 실행하세요.',
  disconnected: 'ChatGPT가 연결되어 있지 않습니다. 설정 → AI에서 연결하세요.',
  ended: 'ChatGPT 로그인이 만료되었습니다. 설정 → AI에서 다시 연결하세요.',
  'plan-disabled': 'ChatGPT 계정은 연결됐지만 플랜 사용이 허용되지 않았습니다. 설정 → AI에서 "ChatGPT 플랜 사용 허용"을 누르세요.',
} as const;

export const START_REFUSAL = {
  'loopback-only': 'ChatGPT 연결은 내 컴퓨터에서 pnpm local로 실행한 StudyAI(http://127.0.0.1 주소)에서만 할 수 있습니다.',
  'not-configured': '이 서버에는 ChatGPT 연결 설정이 없습니다. pnpm local로 다시 실행하세요.',
  superseded: '더 새로운 연결 요청이나 연결 해제가 있어 이 요청을 취소했습니다.',
} as const;
export type StartRefusal = keyof typeof START_REFUSAL;
