import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The side panel (sidepanel.html + React) and the service worker (background.js, an ES module) → dist/.
// The content script is a separate IIFE build (vite.content.config.ts), run after this one (emptyOutDir:false there).
// '@stubyard/client/<module>' is read from the client's sources, so no client build is needed first. Only the
// browser-safe modules are imported (never the package index, which also holds Node-only helpers).
const here = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

export default defineConfig({
  base: './',
  plugins: [react()],
  publicDir: 'public',
  resolve: {
    alias: [{ find: /^@stubyard\/client\/(.+)$/, replacement: `${here('../client/src/')}$1.ts` }],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: { sidepanel: here('./sidepanel.html'), background: here('./src/background.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
