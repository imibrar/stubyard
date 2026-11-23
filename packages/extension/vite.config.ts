import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The side panel (sidepanel.html + React), the on-page widget (widget.html + React, framed by the content script) and
// the service worker (background.js, an ES module) → dist/. The panel and the widget share their chunks.
// The content script is a separate IIFE build (vite.content.config.ts), run after this one (emptyOutDir:false there).
// '@stubyard/client/<module>' is read from the client's sources, so no client build is needed first. Only the
// browser-safe modules are imported (never the package index, which also holds Node-only helpers).
// `vite build --mode harness` (npm run build:test) is the test build for the headless Chrome harness
// (test/widget-spike/): it goes to dist-test/ and turns on __STUBYARD_TEST_HOOKS__ (self.__stubyardCommand in the
// worker). A normal build compiles those hooks out.
const here = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  define: { __STUBYARD_TEST_HOOKS__: JSON.stringify(mode === 'harness') },
  publicDir: 'public',
  resolve: {
    alias: [{ find: /^@stubyard\/client\/(.+)$/, replacement: `${here('../client/src/')}$1.ts` }],
  },
  build: {
    outDir: mode === 'harness' ? 'dist-test' : 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: { sidepanel: here('./sidepanel.html'), widget: here('./widget.html'), offscreen: here('./offscreen.html'), background: here('./src/background.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
}));
