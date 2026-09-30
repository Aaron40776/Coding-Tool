import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Many tests drive real git processes (checkpoints). A Windows CI runner needs a second or more per test for those,
    // so the 5 s default made a slow runner fail on timing alone.
    testTimeout: 30_000,
  },
});
