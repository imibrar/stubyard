import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the dashboard runs on Vite (5173) and proxies API calls to the hub (4000).
const target = process.env.DEVHUB_API ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/mailpit': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
