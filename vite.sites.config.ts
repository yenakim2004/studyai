import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { renderHeadersFile } from './config/headers.ts';

export default defineConfig({
  plugins: [
    react(), tailwindcss(),
    cloudflare({
      viteEnvironment: { name: 'server' }, inspectorPort: false, configPath: './wrangler.sites.jsonc',
    }),
    {
      name: 'studyai-sites-artifacts',
      applyToEnvironment(environment) { return environment.name === 'client'; },
      async generateBundle() {
        this.emitFile({ type: 'asset', fileName: '_headers', source: renderHeadersFile() });
        this.emitFile({ type: 'asset', fileName: 'downloads/studyai-connect.mjs', source: await readFile('dist-cli/studyai-connect.mjs', 'utf8') });
      },
      async closeBundle() {
        await mkdir('dist/.openai', { recursive: true });
        await cp('drizzle', 'dist/.openai/drizzle', { recursive: true });
        try { await cp('.openai/hosting.json', 'dist/.openai/hosting.json'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      },
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'es2023', assetsInlineLimit: 0, sourcemap: false },
});
