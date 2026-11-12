import { build, defineConfig, type UserConfig } from 'vite';

const nodeBundle = (entry: string, fileName: string, emptyOutDir: boolean): UserConfig => ({
  build: {
    ssr: entry,
    outDir: 'dist-cli',
    emptyOutDir,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: fileName } },
  },
  ssr: { noExternal: true, target: 'node' },
});

/**
 * `pnpm cli:build` → two self-contained Node bundles in dist-cli/:
 *  - lecture-cli.mjs, the command-line tool used by the Claude Code skill;
 *  - studyai-connect.mjs, the local ChatGPT sign-in helper for a personal StudyAI Site.
 * The second is built after the first so neither shares a chunk with the other.
 */
export default defineConfig({
  ...nodeBundle('src/cli/main.ts', 'lecture-cli.mjs', true),
  plugins: [
    {
      name: 'studyai-connect-bundle',
      apply: 'build',
      async closeBundle() {
        await build({ configFile: false, publicDir: false, logLevel: 'warn', ...nodeBundle('src/cli/connect-main.ts', 'studyai-connect.mjs', false) });
      },
    },
  ],
});
