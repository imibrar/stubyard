import { defineConfig } from 'vite';
// The content script: one IIFE file (content scripts cannot be ES modules), injected on demand by the side panel and
// by the service worker (on-page widget host). Mode "harness" (npm run build:test) writes next to the test build.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: mode === 'harness' ? 'dist-test' : 'dist',
    emptyOutDir: false,
    lib: { entry: 'src/content/index.ts', formats: ['iife'], name: 'stubyardContent', fileName: () => 'content.js' },
  },
}));
