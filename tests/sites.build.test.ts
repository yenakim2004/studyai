import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { META_CSP } from '../config/headers';

const output = mkdtempSync(join(tmpdir(), 'studyai-sites-'));
beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'sites', '--outDir', output], { stdio: 'pipe' });
}, 120_000);
afterAll(() => rmSync(output, { recursive: true, force: true }));

it('ships root-relative assets, Korean metadata and CSP before scripts, with a deep-link fallback', () => {
  const html = readFileSync(join(output, 'index.html'), 'utf8');
  expect(html).toContain('lang="ko"');
  expect(html).toContain('src="/assets/');
  expect(html).toContain(`content="${META_CSP}"`);
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
  expect(readFileSync(join(output, '404.html'), 'utf8')).toBe(html);
  expect(readFileSync(join(output, '_headers'), 'utf8')).toContain("frame-ancestors 'none'");
});

it('excludes the AI transport, demo sample data and account secrets from every browser script', () => {
  const files = readdirSync(join(output, 'assets'));
  const scripts = files.filter((name) => /\.m?js$/.test(name)).map((name) => readFileSync(join(output, 'assets', name), 'utf8')).join('\n');
  expect(scripts).not.toMatch(/\/api\/(?:status|chatgpt|ai|auth|owner)|auth\.openai\.com|api\.openai\.com|CHATGPT_SEAL_KEY|sample-course/);
  expect(scripts).not.toContain('비행선 항법(가상의 데모 과목)');
  expect(files.some((name) => name.startsWith('sample-course'))).toBe(false);
  expect(scripts).toContain('배포된 사이트에서는 AI 기능을 쓸 수 없습니다.');
  expect(files.some((name) => /^pdf\.worker.*\.mjs$/.test(name))).toBe(true);
  expect(files.some((name) => name.endsWith('.wasm'))).toBe(true);
});
