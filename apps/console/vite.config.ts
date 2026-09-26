import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The local server the dev server forwards API and socket calls to (`pnpm --filter @rp/server dev`). */
const server = process.env.RP_SERVER_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // The server's Content-Security-Policy allows only same-origin files: nothing inline.
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/socket.io': { target: server, ws: true },
    },
  },
});
