import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The Control Plane the dev server forwards API calls to (`pnpm --filter @rp/control-plane dev`). */
const controlPlane = process.env.CP_URL ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // The Control Plane's Content-Security-Policy allows only same-origin files: nothing inline.
    assetsInlineLimit: 0,
    sourcemap: true,
    // One bundle for an internal staff app used on office desktops: no splitting needed yet.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    proxy: { '/v1': { target: controlPlane, changeOrigin: false } },
  },
});
