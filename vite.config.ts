import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = `http://localhost:${process.env.PORT || 8080}`;

export default defineConfig({
  root: 'web',
  // Relative asset URLs + runtime <base href> => the same build works under any BASE_PATH.
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target, ws: true, changeOrigin: false },
    },
  },
});
