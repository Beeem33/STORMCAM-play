import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build can be hosted from any sub-path (LAN static server, GitHub Pages).
  base: './',
  server: {
    host: true,
    port: 8191,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
