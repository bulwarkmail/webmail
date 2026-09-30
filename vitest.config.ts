import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // integration/** is the dockerized Playwright suite (run via
    // `npm run test:integration`); examples/** is untracked sample code; and
    // repos/** holds sibling checkouts with their own runners. node_modules
    // must be globbed at any depth or the nested repos/*/node_modules trees
    // get collected too.
    // scripts/lite/smoke/** is the Playwright smoke for the static Lite export.
    exclude: ['integration/**', 'examples/**', 'repos/**', '**/node_modules/**', '.next/**', 'out/**', 'scripts/lite/smoke/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
