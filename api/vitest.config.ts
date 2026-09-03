import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // These hit the real Supabase project (see test/README.md) rather than a mock --
    // sequential avoids the suites' own idempotency keys colliding with each other.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
