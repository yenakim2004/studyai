#!/usr/bin/env node
/**
 * Starts the REAL Worker and Durable Object locally (wrangler dev, workerd, no Cloudflare account, no network) for the
 * end-to-end tests. Two modes, chosen by playwright.config.ts:
 *
 *   node scripts/e2e-worker-server.mjs        the local launcher's setup: loopback address, a fresh test seal key, and the
 *                                             fake OpenAI issuer with a scripted model (tests/helpers/*.mjs)
 *   node scripts/e2e-worker-server.mjs gate   a hosted copy: the production entry and config with no variables at all, which
 *                                             must serve the study app and refuse every AI route
 *
 * The seal key is generated per run and lives only in this process's arguments to wrangler; state goes to .scratch/ (git-ignored).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createFakeOpenAi, serveFakeOpenAi } from '../tests/helpers/fake-openai.mjs';
import { scriptedModel } from '../tests/helpers/scripted-model.mjs';

// The ports come from playwright.config.ts (tests/e2e/ports.ts); the defaults are the same numbers.
const P = { preview: process.env.E2E_PORT_PREVIEW ?? '4391', worker: process.env.E2E_PORT_WORKER ?? '8792', gate: process.env.E2E_PORT_GATE ?? '8793', stub: process.env.E2E_PORT_STUB ?? '8795' };
const PREVIEW = `http://127.0.0.1:${P.preview}/`;

const hosted = process.argv[2] === 'gate';
const PORT = hosted ? P.gate : P.worker;
const STATE = hosted ? '.scratch/e2e-hosted-state' : '.scratch/e2e-state';

if (!hosted) {
  // OpenAI's stand-in. The Worker reaches it on 127.0.0.1, the browser on localhost, which is a different site from the app,
  // as auth.openai.com is in real use.
  const fakeOpenAi = createFakeOpenAi();
  fakeOpenAi.behaviour.script = scriptedModel;
  const handler = (req, res) => {
    if ((req.url ?? '').startsWith('/oai-') || req.url === '/__oai/log') {
      void serveFakeOpenAi(fakeOpenAi, req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
      return;
    }
    res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
    res.end();
  };
  createServer(handler).listen(Number(P.stub), '127.0.0.1');
  // Browsers may resolve localhost to ::1 first. Where IPv6 loopback is missing, 127.0.0.1 alone still answers.
  createServer(handler).on('error', () => {}).listen(Number(P.stub), '::1');
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// The production build (served by the other web server) must be finished before the Worker serves it as assets.
await waitFor(PREVIEW, 300_000);

rmSync(STATE, { recursive: true, force: true });
mkdirSync('.scratch', { recursive: true });
// An explicit, empty env file, so a developer's own .dev.vars or .env can never change what these servers are.
writeFileSync('.scratch/e2e-empty.env', '');

const vars = hosted
  ? []
  : ['--var', `STUDYAI_LOOPBACK:127.0.0.1:${PORT}`, '--var', `CHATGPT_SEAL_KEY:${randomBytes(32).toString('base64url')}`, '--var', `OPENAI_STUB_URL:http://127.0.0.1:${P.stub}`, '--var', `OPENAI_STUB_BROWSER_URL:http://localhost:${P.stub}`];
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '-c', hosted ? 'wrangler.jsonc' : 'wrangler.test.jsonc', '--port', PORT, '--ip', '127.0.0.1', '--local', '--persist-to', STATE, '--env-file', '.scratch/e2e-empty.env', ...vars], {
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
