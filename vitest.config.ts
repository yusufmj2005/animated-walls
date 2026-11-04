import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@animated-walls/shared-types': resolve(import.meta.dirname, 'packages/shared-types/src/index.ts'),
      '@animated-walls/wallpaper-format': resolve(import.meta.dirname, 'packages/wallpaper-format/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/desktop/test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
