import { z } from 'zod';

const SiteUserIdSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).brand<'SiteUserId'>();
export type SiteUserId = z.infer<typeof SiteUserIdSchema>;

export type SiteRequestBoundary =
  | { ok: true; userId: SiteUserId }
  | { ok: false; status: 401 | 403 | 415 | 503; code: 'site-not-configured' | 'site-signin-required' | 'cross-site' | 'json-required' };

export function parseSiteOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

/** Only for a Sites entry behind dispatch, which supplies and overwrites the identity header. */
export function checkSiteRequest(request: Request, siteOrigin: string | null): SiteRequestBoundary {
  if (!siteOrigin) return { ok: false, status: 503, code: 'site-not-configured' };
  const user = SiteUserIdSchema.safeParse(request.headers.get('oai-authenticated-user-id'));
  if (!user.success) return { ok: false, status: 401, code: 'site-signin-required' };

  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if ((origin !== null && origin !== siteOrigin) || (fetchSite !== null && fetchSite !== 'same-origin')) {
    return { ok: false, status: 403, code: 'cross-site' };
  }
  if (request.method === 'POST') {
    if (origin !== siteOrigin) return { ok: false, status: 403, code: 'cross-site' };
    const mime = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mime !== 'application/json') return { ok: false, status: 415, code: 'json-required' };
  }
  return { ok: true, userId: user.data };
}
