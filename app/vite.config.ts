import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@muninn/types/session-identity': resolve(__dirname, '../packages/types/src/session_identity.ts'),
    },
  },
  root: 'src',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
