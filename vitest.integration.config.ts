import { defineConfig } from 'vitest/config';

// Real Postgres, real Neo4j, real Redis, real Redpanda. `npm run infra:up`
// first. The invalidation window is the product of this repository and it is
// not a number a fake can produce.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // One store, shared fixtures, ordered assertions about propagation. Running
    // these in parallel would have them invalidating each other's generations.
    fileParallelism: false,
  },
});
