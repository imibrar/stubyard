import { defineConfig } from 'vitest/config';

// '@stubyard/client/<module>' is read from the client's sources, as in vite.config.ts (no client build needed).
const here = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

export default defineConfig({
  resolve: { alias: [{ find: /^@stubyard\/client\/(.+)$/, replacement: `${here('../client/src/')}$1.ts` }] },
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts'] },
});
