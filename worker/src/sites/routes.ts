import { z } from 'zod';
import { AiTaskSchema } from '../../../src/core/tutor/contract';
import { BRIDGE_FILE_MAX_BYTES } from '../../../src/core/chatgpt/bridge';
import { CHATGPT_REPLY, SIGN_IN_SENTENCE, START_REFUSAL } from '../../../src/core/chatgpt/messages';
import { json, readJson, statusForCode } from '../app';
import { HostedAccessError, type HostedChatGptAccount } from '../hosted/account';
import { checkSiteRequest } from './boundary';

type SiteAccount = Pick<HostedChatGptAccount, 'status' | 'createPairing' | 'install' | 'ask' | 'models' | 'selectModel' | 'resume' | 'disconnect'>;

const StartSchema = z.object({ account: z.enum(['current', 'other']).default('current'), forceConsent: z.boolean().default(false) }).strict();
const DisconnectSchema = z.object({ forget: z.boolean().default(false) }).strict();
const ModelSchema = z.object({ model: z.string().min(1).max(200) }).strict();
const EmptySchema = z.object({}).strict();
const BOUNDARY_MESSAGE = {
  'site-not-configured': '이 사이트의 서버 주소 설정이 필요합니다.',
  'site-signin-required': '이 비공개 사이트에 로그인한 뒤 다시 시도하세요.',
  'cross-site': '이 사이트에서 직접 보낸 요청만 받습니다.',
  'json-required': 'JSON 형식의 요청만 받습니다.',
} as const;
const invalid = () => json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
const askSlots = new Set<{ until: number }>();

/** The account is constructed only after Sites identity and request-origin checks pass. */
export async function handleSiteApi(request: Request, siteOrigin: string | null, account: () => SiteAccount): Promise<Response> {
  const boundary = checkSiteRequest(request, siteOrigin);
  if (!boundary.ok) return json({ ok: false, code: boundary.code, message: BOUNDARY_MESSAGE[boundary.code] }, boundary.status);
  if (request.method !== 'GET' && request.method !== 'POST') return json({ ok: false, message: 'GET과 POST 요청만 받습니다.' }, 405, { allow: 'GET, POST' });
  const path = new URL(request.url).pathname;
  const user = boundary.userId;
  try {
    const a = account();
    if (request.method === 'GET') {
      if (path === '/api/status') return json(await a.status(user));
      if (path === '/api/chatgpt/models') {
        const r = await a.models(user);
        return json(r, r.ok ? 200 : statusForCode(r.code));
      }
    } else {
      const body = await readJson(request, path === '/api/chatgpt/install' ? BRIDGE_FILE_MAX_BYTES : undefined);
      if (!body.ok) return body.response;
      switch (path) {
        case '/api/chatgpt/pairing': {
          const o = StartSchema.safeParse(body.value);
          if (!o.success) return invalid();
          const r = await a.createPairing(user, o.data);
          return r.ok ? json(r) : json({ ok: false, message: START_REFUSAL[r.error] }, r.error === 'superseded' ? 409 : 503);
        }
        case '/api/chatgpt/install': {
          const r = await a.install(user, body.value);
          return json({ ok: r.outcome === 'connected', outcome: r.outcome, message: SIGN_IN_SENTENCE[r.outcome] }, r.outcome === 'connected' ? 200 : 400);
        }
        case '/api/chatgpt/disconnect': {
          const o = DisconnectSchema.safeParse(body.value);
          return o.success ? json(await a.disconnect(user, o.data)) : invalid();
        }
        case '/api/chatgpt/model': {
          const o = ModelSchema.safeParse(body.value);
          if (!o.success) return invalid();
          const r = await a.selectModel(user, o.data.model);
          return r.ok ? json(r) : json({ ok: false, message: r.error }, 400);
        }
        case '/api/chatgpt/resume':
          if (!EmptySchema.safeParse(body.value).success) return invalid();
          await a.resume(user);
          return json({ ok: true });
        case '/api/ai/ask': {
          const task = AiTaskSchema.safeParse(body.value);
          if (!task.success) return invalid();
          const now = Date.now();
          for (const slot of askSlots) if (slot.until <= now) askSlots.delete(slot);
          if (askSlots.size >= 2) return json({ ok: false, code: 'chatgpt-busy', message: CHATGPT_REPLY['chatgpt-busy'].message }, 429);
          // A disconnected request may never resume its finally block in Workers.
          const slot = { until: now + 180_000 };
          askSlots.add(slot);
          try {
            const r = await a.ask(user, task.data);
            return json(r, r.ok ? 200 : statusForCode(r.code));
          } finally { askSlots.delete(slot); }
        }
      }
    }
    return json({ ok: false, message: '없는 API 주소입니다.' }, 404);
  } catch (error) {
    if (error instanceof HostedAccessError) return json({ ok: false, message: error.message }, error.status);
    return json({ ok: false, message: '사이트 서버에서 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.' }, 500);
  }
}
