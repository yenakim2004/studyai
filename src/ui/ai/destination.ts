import { AI_CONSENT_KEY } from '@/core/tutor/contract';

/** Where every AI request goes, and the consent each AI screen asks for before the first one. */
export const AI_DESTINATION = {
  consentKey: AI_CONSENT_KEY.chatgpt,
  /** "… 보낼 내용" heading: what will be sent, and to whom. */
  sentTo: 'OpenAI (내 ChatGPT 플랜)',
  consent: '위에 보이는 내용이 내 ChatGPT 계정으로 OpenAI에 보내진다는 것을 이해합니다. StudyAI는 응답 저장을 요청하지 않지만(store: false), OpenAI의 약관과 개인정보 정책이 적용됩니다.',
} as const;
