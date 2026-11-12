import { SECURITY_HEADERS } from '../../config/headers';
import { HostedChatGptAccount } from './hosted/account';
import { parseSiteOrigin } from './sites/boundary';
import { handleSiteApi } from './sites/routes';

export interface SitesEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  CHATGPT_SEAL_KEY?: string;
  STUDYAI_SITE_ORIGIN?: string;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return handleSiteApi(request, parseSiteOrigin(env.STUDYAI_SITE_ORIGIN), () => new HostedChatGptAccount({
        db: env.DB,
        sealKey: env.CHATGPT_SEAL_KEY,
        http: (url, init) => fetch(url, init),
        now: Date.now,
        defer: (promise) => ctx.waitUntil(promise),
      }));
    }
    let asset = await env.ASSETS.fetch(request);
    if (asset.status === 404 && (request.method === 'GET' || request.method === 'HEAD') && request.headers.get('accept')?.includes('text/html')) {
      asset = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
    return response;
  },
} satisfies ExportedHandler<SitesEnv>;
