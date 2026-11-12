import { route, type AppEnv } from './app';
import { StudyAiDO } from './do';
import { AUTHORIZE_URL, type OutboundFetch } from '../../src/core/chatgpt/oauth';
import { CHATGPT_KEYS } from './chatgpt';
import { isLoopbackRequest, parseLoopback } from './loopback';

type TestEnv = Env & { OPENAI_STUB_URL?: string; OPENAI_STUB_BROWSER_URL?: string };

/**
 * LOCAL TEST ENTRY ONLY (wrangler.test.jsonc, used by the end-to-end tests). It moves OpenAI's fixed addresses onto the
 * local fake issuer (tests/helpers/fake-openai.mjs) so the whole site runs with no account and no network. The production
 * entry (index.ts) never imports this file, and a test checks that the production bundle contains none of it.
 */
export class StudyAiTestDO extends StudyAiDO {
  protected override createOpenAiFetch(): OutboundFetch {
    const stub = (this.env as TestEnv).OPENAI_STUB_URL;
    if (!stub) return super.createOpenAiFetch();
    return (url, init) => fetch(url.replace(/^https:\/\/auth\.openai\.com\//, `${stub}/oai-auth/`).replace(/^https:\/\/api\.openai\.com\//, `${stub}/oai-api/`), init);
  }

  /** The browser goes to the fake issuer on `localhost`, a different site from 127.0.0.1, so the return trip is cross-site. */
  protected override browserAuthorizeUrl(url: string): string {
    const browser = (this.env as TestEnv).OPENAI_STUB_BROWSER_URL;
    return browser && url.startsWith(`${AUTHORIZE_URL}?`) ? `${browser}/oai-auth/api/accounts/authorize${url.slice(AUTHORIZE_URL.length)}` : url;
  }

  /** Forgets the ChatGPT account, so each test starts disconnected. Exists only in this test class. */
  async resetChatGptForTests(): Promise<void> {
    for (const k of CHATGPT_KEYS) this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', k);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const loopback = parseLoopback(env);
    const backend = (env.STUDYAI as DurableObjectNamespace<StudyAiTestDO>).getByName('owner');
    if (new URL(request.url).pathname === '/api/test/reset-chatgpt' && request.method === 'POST' && loopback && isLoopbackRequest(request, loopback)) {
      await backend.resetChatGptForTests();
      return new Response('reset', { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    const app: AppEnv = { backend, loopback };
    return route(request, app, (r) => env.ASSETS.fetch(r));
  },
} satisfies ExportedHandler<Env>;
