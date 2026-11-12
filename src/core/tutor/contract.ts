import { z } from 'zod';
import { QUESTION_TYPES, TUTOR_MODES } from '../study/types';

/**
 * The only requests the AI endpoint accepts. The browser sends structured data; the SERVER turns it into the prompt
 * (prompts.ts) and picks the model from the connected ChatGPT account. The browser can never supply a system prompt, a
 * model, a tool or an output length.
 */

export { TUTOR_MODES };
export type TutorMode = (typeof TUTOR_MODES)[number];

export const TUTOR_MODE_LABEL: Record<TutorMode, string> = {
  explain: '쉽게 설명',
  steps: '단계별 설명',
  exam: '시험 답안 쓰는 법',
  socratic: '질문으로 이끌기',
  quiz: '퀴즈 내기',
  summary: '요약',
  compare: '비교와 대조',
  mistakes: '자주 하는 실수',
};

/** Hard limits (characters). They keep one request small enough for one ChatGPT answer. */
export const LIMITS = {
  question: 4_000,
  excerptText: 8_000,
  excerpts: 30,
  excerptsTotal: 60_000,
  historyMessage: 6_000,
  historyMessages: 10,
  historyTotal: 24_000,
  examStyle: 2_000,
  name: 200,
  answer: 20_000,
  lectureMarkdown: 80_000,
} as const;

const short = (max: number) => z.string().max(max);

export const ExcerptSchema = z
  .object({
    /** "S1", "S2", … — the label the model must cite. The browser maps it back to a lecture and slide. */
    ref: z.string().regex(/^S\d{1,3}$/),
    lectureTitle: short(LIMITS.name),
    /** Slide number; 0 for a note (see `kind`). */
    slide: z.number().int().min(0).max(10_000),
    /** "note" = one of the student's own notes (not the professor's material). */
    kind: z.enum(['slide', 'note']).optional(),
    title: short(LIMITS.name),
    text: short(LIMITS.excerptText),
  })
  .strict();
export type Excerpt = z.infer<typeof ExcerptSchema>;

const Turn = z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(LIMITS.historyMessage) }).strict();

export const TutorRequestSchema = z
  .object({
    task: z.literal('tutor'),
    mode: z.enum(TUTOR_MODES),
    question: z.string().min(1).max(LIMITS.question),
    excerpts: z.array(ExcerptSchema).min(1).max(LIMITS.excerpts),
    history: z.array(Turn).max(LIMITS.historyMessages),
    courseName: short(LIMITS.name).optional(),
    examStyle: short(LIMITS.examStyle).optional(),
    /** Facts the app found about the slides being sent (see gaps.ts): a heading with no content, an unread picture, … */
    gaps: z.array(short(300)).max(12).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const total = v.excerpts.reduce((n, e) => n + e.text.length, 0);
    if (total > LIMITS.excerptsTotal) ctx.addIssue({ code: 'custom', message: '고른 슬라이드의 글이 너무 많아 한 번에 질문할 수 없습니다.' });
    if (v.history.reduce((n, h) => n + h.text.length, 0) > LIMITS.historyTotal) ctx.addIssue({ code: 'custom', message: '대화가 너무 깁니다. 새 대화를 시작하세요.' });
    const refs = new Set(v.excerpts.map((e) => e.ref));
    if (refs.size !== v.excerpts.length) ctx.addIssue({ code: 'custom', message: '슬라이드 표시가 겹칩니다.' });
  });
export type TutorRequest = z.infer<typeof TutorRequestSchema>;

/** One planned question (see blueprint.ts). The browser sends the plan as data; the server turns it into the prompt. */
export const PlannedQuestionSchema = z
  .object({
    type: z.enum(QUESTION_TYPES),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    marks: z.number().min(0.5).max(20),
    points: z.number().int().min(1).max(8),
    topic: short(LIMITS.name),
    slides: z.array(z.number().int().min(1).max(10_000)).min(1).max(8),
  })
  .strict();

export const GenerateRequestSchema = z
  .object({
    task: z.literal('generate'),
    /** `lectureToMarkdown()` output for the chosen lectures (slide numbers kept so the model can cite them). */
    lectureMarkdown: z.string().min(20).max(LIMITS.lectureMarkdown),
    wants: z.object({ notes: z.boolean(), cards: z.boolean(), questions: z.boolean() }).strict(),
    amount: z.enum(['few', 'normal', 'many']),
    examStyle: short(LIMITS.examStyle).optional(),
    /** The questions to write, planned on the device: type, difficulty, marks, marking points, topic and slides for each. */
    blueprint: z.array(PlannedQuestionSchema).min(1).max(12).optional(),
    /** Questions that already exist, so the model does not repeat them. */
    alreadyAsked: z.array(short(240)).max(40).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.blueprint && !v.wants.questions) ctx.addIssue({ code: 'custom', message: '문제 계획을 보내려면 문제 만들기를 선택해야 합니다.' });
  });
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const GradeRequestSchema = z
  .object({
    task: z.literal('grade'),
    question: z
      .object({
        type: z.enum(QUESTION_TYPES),
        prompt: short(10_000),
        marks: z.number().min(0.5).max(1_000),
        modelAnswer: short(10_000).optional(),
        rubric: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, '채점 기준 ID에는 영문자, 숫자, -, _만 쓸 수 있습니다.'), text: short(2_000), marks: z.number().min(0).max(1_000) }).strict()).min(1).max(30),
      })
      .strict(),
    answer: z.string().max(LIMITS.answer),
    /** Slide text the question came from (optional; helps the grader stay faithful to the lecture). */
    excerpts: z.array(ExcerptSchema).max(6).optional(),
  })
  .strict();
export type GradeRequest = z.infer<typeof GradeRequestSchema>;

/** Questions whose marking points are to be checked against what each question asks (see study/audit.ts). */
export const AuditRequestSchema = z
  .object({
    task: z.literal('audit'),
    questions: z
      .array(
        z
          .object({
            n: z.number().int().min(1).max(5_000),
            type: z.enum(QUESTION_TYPES),
            prompt: short(4_000),
            marks: z.number().min(0.5).max(1_000),
            rubric: z.array(z.object({ text: short(600), marks: z.number().min(0).max(1_000) }).strict()).min(1).max(12),
            modelAnswer: short(3_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type AuditRequest = z.infer<typeof AuditRequestSchema>;

export const AiTaskSchema = z.discriminatedUnion('task', [TutorRequestSchema, GenerateRequestSchema, GradeRequestSchema, AuditRequestSchema]);
export type AiTask = z.infer<typeof AiTaskSchema>;

/**
 * Consent to send text to OpenAI through the user's ChatGPT plan, kept on this device only (backups never carry it). An
 * object so that backup.ts can list every device-only key. The stored key name is unchanged, so earlier consent survives.
 */
export const AI_CONSENT_KEY = { chatgpt: 'aiConsentAt:chatgpt' } as const;

/** The output cap every prompt is built with (prompts.ts). The Responses route takes no output limit, so it shapes the prompt only. */
export const AI_OUTPUT_CAP = 4_000;

/** What the AI endpoint answers with. A refusal or failure carries one fixed Korean sentence. */
export type AiReply = { ok: true; text: string; model: string } | { ok: false; code: string; message: string };

/** A model the signed-in ChatGPT account may use. `slug` goes upstream, `displayName` goes on screen. */
export interface ChatGptModel {
  slug: string;
  displayName: string;
}

/** The fixed outcomes of one ChatGPT sign-in attempt. The callback page and Settings show one fixed sentence for each. */
export const SIGN_IN_OUTCOMES = [
  'connected',
  'denied',
  'expired',
  'unknown-attempt',
  'registration-incomplete',
  'client-mismatch',
  'code-rejected',
  'client-invalid',
  'id-token-invalid',
  'account-mismatch',
  'plan-not-enabled',
  'superseded',
  'upstream-unavailable',
] as const;
export type SignInOutcome = (typeof SIGN_IN_OUTCOMES)[number];

/** The latest thing worth telling the user about the ChatGPT connection. */
export type ChatGptNotice =
  | { kind: 'sign-in'; outcome: SignInOutcome; at: number }
  | { kind: 'session-ended'; reason: 'refresh-rejected' | 'invalid-client' | 'unreadable'; at: number }
  | { kind: 'disconnected'; remoteRevoked: boolean | null; at: number };

export type ChatGptPauseCode = 'usage-limit' | 'not-eligible';

export type ChatGptConnection =
  | { kind: 'disconnected'; /** A saved registration exists, so the next sign-in reuses its client. */ registered: boolean; email: string | null }
  /** Signed in without the plan scope: the account is known, but ChatGPT plan usage is disabled until consent is given. */
  | { kind: 'plan-disabled'; email: string | null }
  | { kind: 'connected'; email: string | null; model: ChatGptModel | null; pause: { code: ChatGptPauseCode; since: number } | null };

/** GET /api/status. `state` and `reasons` are the one gate every AI screen reads. */
export interface AiStatus {
  state: 'off' | 'ready' | 'paused';
  /** Korean sentences saying why AI cannot answer right now. Empty while ready. */
  reasons: string[];
  /** True when this server runs under the local launcher with its seal key, so a sign-in can start here. */
  signInAvailable: boolean;
  connection: ChatGptConnection;
  /** Set while a started sign-in can still come back. */
  pendingUntil: number | null;
  notice: ChatGptNotice | null;
}
