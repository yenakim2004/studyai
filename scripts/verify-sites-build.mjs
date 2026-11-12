import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const config = await readJson('dist/server/wrangler.json');
assert.equal(config.main, 'index.js');
assert.equal(config.assets.binding, 'ASSETS');
assert.equal(config.assets.directory, '../client');
assert.deepEqual(config.durable_objects.bindings, []);
assert.equal(config.d1_databases[0].binding, 'DB');
assert.deepEqual(config.assets.run_worker_first, ['/api/*']);
assert.equal(await readFile('dist/client/downloads/studyai-connect.mjs', 'utf8'), await readFile('dist-cli/studyai-connect.mjs', 'utf8'));
for (const name of await readdir('dist/client/assets')) {
  if (!/\.m?js$/.test(name)) continue;
  const script = await readFile(join('dist/client/assets', name), 'utf8');
  assert.doesNotMatch(script, /auth\.openai\.com|api\.openai\.com|CHATGPT_SEAL_KEY|refresh_token|privateJwk/);
}

const wrangler = createRequire(import.meta.url).resolve('wrangler/package.json');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(createRequire(wrangler).resolve('miniflare')).href);
const origin = 'https://studyai.example.test';
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: await readFile('dist/server/index.js', 'utf8'),
  compatibilityDate: config.compatibility_date, host: '127.0.0.1', port: 0,
  bindings: { STUDYAI_SITE_ORIGIN: origin, CHATGPT_SEAL_KEY: randomBytes(32).toString('base64url') },
  d1Databases: ['DB'],
}));
try {
  const db = await mf.getD1Database('DB');
  for (const { tag } of (await readJson('drizzle/meta/_journal.json')).entries) {
    const sql = await readFile(`drizzle/${tag}.sql`, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const headers = { 'oai-authenticated-user-id': 'synthetic-owner', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  assert.equal((await mf.dispatchFetch(origin + '/api/status')).status, 401);
  const initial = await mf.dispatchFetch(origin + '/api/status', { headers });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).connection.kind, 'disconnected');
  const pairing = await mf.dispatchFetch(origin + '/api/chatgpt/pairing', { headers, method: 'POST', body: JSON.stringify({ account: 'current', forceConsent: false }) });
  assert.equal(pairing.status, 200);
  const result = await pairing.json();
  assert.equal(result.request.v, 'studyai-pairing/1');
  assert.equal(result.request.publicKey.kty, 'EC');
  assert.equal(result.request.publicKey.d, undefined);
  const status = await mf.dispatchFetch(origin + '/api/status', { headers }).then(r => r.json());
  assert.equal(status.connectVia, 'file');
  assert.ok(status.pendingUntil > Date.now());
  console.log('Sites artifact verified: browser bundle, connector download, production workerd entry, D1 migration and pairing. No real OpenAI calls.');
} finally {
  await mf.dispose();
}
