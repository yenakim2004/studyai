import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Things the Cloudflare Workers runtime rejects at run time, which no local fake can notice because a fake never calls the
 * real `fetch`. Each rule here comes from a real failure: an early live request threw before leaving the Worker because
 * `redirect: 'error'` is not implemented there ("must be one of follow or manual").
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
  });
}

describe('code that runs in the Worker only uses options the Workers runtime supports', () => {
  const files = [...sources('worker/src'), ...sources('src/core/ai'), ...sources('src/core/tutor'), ...sources('src/core/chatgpt')];

  it('never asks fetch for redirect: "error" (Workers support only "follow" and "manual")', () => {
    const offenders = files.filter((f) => /redirect\s*:\s*['"]error['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the OpenAI adapters refuse to follow redirects ("manual")', () => {
    for (const f of ['src/core/chatgpt/oauth.ts', 'src/core/chatgpt/responses.ts']) expect(readFileSync(f, 'utf8'), f).toMatch(/redirect\s*:\s*'manual'/);
  });

  it('the ChatGPT protocol and account code import nothing from Node or Cloudflare (they run in workerd and in tests)', () => {
    for (const f of [...sources('src/core/chatgpt'), 'worker/src/chatgpt.ts', 'worker/src/loopback.ts']) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from\s+['"](node:|cloudflare:)/);
  });

  it('OpenAI addresses are fixed constants: no endpoint comes from the environment in production code', () => {
    for (const f of [...sources('src/core/chatgpt'), 'worker/src/chatgpt.ts', 'worker/src/do.ts', 'worker/src/index.ts']) expect(readFileSync(f, 'utf8'), f).not.toMatch(/OPENAI_STUB|OPENAI_BASE|env\.\w*OPENAI/);
  });
});
