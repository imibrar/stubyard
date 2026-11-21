import { defineConfig } from 'vite';
// The content script: one IIFE file (content scripts cannot be ES modules), injected on demand by the side panel.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: { entry: 'src/content/index.ts', formats: ['iife'], name: 'stubyardContent', fileName: () => 'content.js' },
  },
});
