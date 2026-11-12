import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { demoBase, injectDemoHead, injectSitesHead } from './config/demo-html.ts';
import { renderHeadersFile, SECURITY_HEADERS } from './config/headers.ts';

/** Emits dist/_headers so Cloudflare serves the same CSP/security headers the preview server used in tests. */
function securityHeadersFile(): Plugin {
  return {
    name: 'studyai-security-headers',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: renderHeadersFile() });
    },
  };
}

function staticSite(demo: boolean): Plugin {
  return {
    name: 'studyai-static-site',
    apply: 'build',
    transformIndexHtml: { order: 'pre', handler: demo ? injectDemoHead : injectSitesHead },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset') throw new Error('정적 사이트 빌드에서 index.html을 생성하지 못했습니다.');
        this.emitFile({ type: 'asset', fileName: '404.html', source: page.source });
      },
    },
  };
}

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  const sites = mode === 'sites';
  const hosted = demo || sites;
  return {
    // The demo lives under a sub-path (https://<owner>.github.io/studyai/); the regular build is served from the root.
    base: demo ? demoBase() : '/',
    plugins: [react(), tailwindcss(), ...(hosted ? [staticSite(demo)] : []), ...(!demo ? [securityHeadersFile()] : [])],
    resolve: {
      alias: hosted
        ? [
            { find: /^@\/app\/ai$/, replacement: fileURLToPath(new URL('./src/app/ai.demo.ts', import.meta.url)) },
            { find: '@', replacement: src },
          ]
        : { '@': src },
    },
    build: {
      target: 'es2023',
      sourcemap: false,
      outDir: demo ? 'dist-demo' : 'dist',
      // Never inline assets as data: URIs: the CSP only allows fonts/images from our own origin.
      assetsInlineLimit: 0,
    },
    // The library lives in IndexedDB, which the browser scopes to the exact address. If port 5173 were busy, Vite would
    // quietly move to 5174 and the student would see an empty library; stop with an error instead (`--port` overrides).
    server: { port: 5173, strictPort: true },
    // `vite preview` serves the production build with the production policy. Static builds carry their policy in the page, so their
    // preview sends no headers: a test then proves that the policy in the page is what is enforced.
    preview: { headers: hosted ? {} : SECURITY_HEADERS },
    test: {
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
      environment: 'node',
      // UI/IndexedDB tests opt in with: // @vitest-environment happy-dom
      testTimeout: 20_000,
    },
  };
});
