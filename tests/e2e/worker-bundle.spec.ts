import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * The PRODUCTION Worker bundle, built locally by `wrangler deploy --dry-run` (no login, no network, nothing deployed).
 * It contains the ChatGPT-plan adapter with OpenAI's fixed addresses and nothing else that can reach a model: no Gemini, no
 * Claude, no owner key or session code, no test fake and no secret-shaped values.
 */
test('the production Worker bundle has only the ChatGPT adapter, no key or session code, no test fake and no secrets', async () => {
  rmSync('.scratch/dry-bundle', { recursive: true, force: true });
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', '.scratch/dry-bundle'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, stdio: 'pipe', timeout: 120_000 });
  const code = readFileSync('.scratch/dry-bundle/index.js', 'utf8');

  expect(code).toContain('https://auth.openai.com');
  expect(code).toContain('/api/accounts/authorize');
  expect(code).toContain('https://api.openai.com/v1/responses');
  for (const forbidden of [
    'generativelanguage.googleapis.com',
    'x-goog-api-key',
    'GEMINI',
    'api.anthropic.com',
    'anthropic-version',
    'OWNER_KEY_HASH',
    'SESSION_SECRET',
    '__Host-studyai_session',
    '/api/auth/',
    '/api/owner/',
    'StudyAiTestDO',
    'OPENAI_STUB',
    'oai-auth',
    'resetChatGptForTests',
    'fake-openai',
  ])
    expect(code, forbidden).not.toContain(forbidden);
  expect(code).not.toMatch(/AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{20,}|sak_[A-Za-z0-9_-]{43}/);
  expect(statSync('.scratch/dry-bundle/index.js').size).toBeLessThan(2_000_000);
});
