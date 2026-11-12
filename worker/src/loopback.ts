import { loopbackRedirectUri, type LoopbackRedirectUri } from '../../src/core/chatgpt/oauth';
import { SIGN_IN_SENTENCE } from '../../src/core/chatgpt/messages';
import type { SignInOutcome } from '../../src/core/tutor/contract';

/**
 * The one decision "this server is the user's local launcher", and the one boundary of its API. ChatGPT exists only here:
 * OpenAI accepts a loopback redirect for this flow, and the account belongs to whoever runs the launcher on this computer.
 * A hosted copy has no loopback, so its API refuses every AI route and the shared account is never reachable from it.
 */

export interface Loopback {
  /** "127.0.0.1:<port>", the only Host the API and the callback accept. */
  host: string;
  /** "http://127.0.0.1:<port>", the only Origin the API accepts. */
  origin: string;
  redirectUri: LoopbackRedirectUri;
}

/**
 * Non-null only when STUDYAI_LOOPBACK is exactly "127.0.0.1:<port>" (1024 to 65535). `localhost` is refused: OpenAI's
 * loopback rule names 127.0.0.1, and one fixed host is what makes the Host check below exact.
 */
export function parseLoopback(env: { STUDYAI_LOOPBACK?: string | undefined }): Loopback | null {
  const m = /^127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(env.STUDYAI_LOOPBACK ?? '');
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1024 || port > 65_535) return null;
  const host = `127.0.0.1:${port}`;
  const redirectUri = loopbackRedirectUri(port);
  return redirectUri ? { host, origin: `http://${host}`, redirectUri } : null;
}

/** The Host header and the URL must both name the loopback host exactly. This is what defeats DNS rebinding. */
export function isLoopbackRequest(request: Request, lb: Loopback): boolean {
  const header = (request.headers.get('host') ?? '').toLowerCase();
  let urlHost = '';
  try {
    urlHost = new URL(request.url).host.toLowerCase();
  } catch {
    return false;
  }
  return header === lb.host && urlHost === lb.host;
}

export type LocalRefusal = 'wrong-host' | 'cross-site';

/**
 * Whether one API request comes from the app itself, opened at the loopback address. There is no key and no cookie: the
 * exact Host stops rebinding, and the Origin and Fetch Metadata checks stop every other page, including other ports on
 * 127.0.0.1 (`same-site`). A browser always sends Origin on a POST; a same-origin GET may omit it, as a local tool's
 * plain fetch does (the launcher's self-check).
 */
export function localRequestProblem(request: Request, lb: Loopback): LocalRefusal | null {
  if (!isLoopbackRequest(request, lb)) return 'wrong-host';
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'cross-site';
  const origin = request.headers.get('origin');
  if (origin === null) return request.method.toUpperCase() === 'GET' ? null : 'cross-site';
  return origin === lb.origin ? null : 'cross-site';
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1c1b19;--muted:#5b5851;--card:#ffffff;--line:#cfcac0;--accent:#1f4fd8;--accent-fg:#ffffff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#efede8;--muted:#a9a59b;--card:#201f1c;--line:#44413a;--accent:#8aa8ff;--accent-fg:#0d1530}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{width:100%;max-width:30rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{margin:0 0 10px;font-size:1.3rem}
p{margin:0 0 20px;color:var(--muted)}
a{display:inline-block;padding:10px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-weight:600;text-decoration:none}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`.trim();

/** A fixed page with no script and no text from the request. Its one link goes back to Settings in the app. */
export function callbackPage(outcome: SignInOutcome): string {
  const title = outcome === 'connected' ? 'ChatGPT 연결 완료' : 'ChatGPT 연결을 마치지 못했습니다';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${SIGN_IN_SENTENCE[outcome]}</p>
<a href="/settings">StudyAI 설정으로 돌아가기</a>
</main>
</body>
</html>
`;
}

let styleHash: Promise<string> | undefined;
const styleSource = (): Promise<string> =>
  (styleHash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(STYLE)).then((d) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`));

/** `no-referrer` because the address holds the one-time code; `no-store` so the page is never replayed from cache. */
export async function callbackHeaders(): Promise<Record<string, string>> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src ${await styleSource()}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'cross-origin-resource-policy': 'same-origin',
  };
}
