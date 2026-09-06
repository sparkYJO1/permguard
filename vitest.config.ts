import { defineConfig } from 'vitest/config';

// Unit tests only. These run with no Docker and no network — they cover the
// role lattice, the cache-key derivation and the decision orchestration, all of
// which are pure. Everything that touches a store lives in the integration
// config, because a mock cannot tell you how long an invalidation takes.
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
