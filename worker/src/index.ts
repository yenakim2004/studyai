import { route, type AppEnv } from './app';
import { parseLoopback } from './loopback';

export { StudyAiDO } from './do';

/**
 * Entry point. Only /api/* and /auth/* come through here (`run_worker_first` in wrangler.jsonc); every other path is the
 * app's static files, which hold no private data. /auth/callback is the local ChatGPT sign-in return. Without
 * STUDYAI_LOOPBACK (every hosted copy) the API answers only health and a Korean "local only" refusal, and the
 * Durable Object is never addressed. There is deliberately no route that proxies arbitrary requests anywhere.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const app: AppEnv = { backend: env.STUDYAI.getByName('owner'), loopback: parseLoopback(env) };
    return route(request, app, (r) => env.ASSETS.fetch(r));
  },
} satisfies ExportedHandler<Env>;
