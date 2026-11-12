import { z } from 'zod';

/**
 * The request prompts.ts builds for one task: plain text in, plain text out, no tools and no images. The ChatGPT adapter
 * sends only `system` and `messages` (see src/core/chatgpt/responses.ts).
 */
export const MessageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }).strict();

export const AiRequestSchema = z
  .object({
    model: z.string().min(1).max(64),
    /** What the call is for ("tutor", "grade", …). */
    purpose: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    system: z.string().optional(),
    messages: z.array(MessageSchema).min(1).max(40),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(1).optional(),
  })
  .strict();

export type AiRequest = z.infer<typeof AiRequestSchema>;

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

/** Tokens added per message and per request for roles and formatting (generous; bytes already over-count text). */
const PER_MESSAGE_OVERHEAD = 16;
const BASE_OVERHEAD = 64;

/**
 * A hard upper bound on the prompt's token count: a token always stands for at least one byte of the text, so the UTF-8
 * byte length plus a formatting allowance can never be less than the real count.
 */
export function inputTokenBound(req: Pick<AiRequest, 'system' | 'messages'>): number {
  let total = BASE_OVERHEAD + (req.system ? byteLength(req.system) : 0);
  for (const m of req.messages) total += byteLength(m.content) + PER_MESSAGE_OVERHEAD;
  return total;
}
