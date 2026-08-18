import { defineConfig } from 'vitest/config';

/**
 * Root guard. The intended entry point is `pnpm test`, which delegates to each
 * workspace package. But running `vitest` at the repo root is an easy mistake,
 * and without this it walks lib/ (the pinned Uniswap submodules) and picks up
 * ~1,800 files that were never meant for this runner.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    exclude: [
      '**/node_modules/**',
      'lib/**',
      'out/**',
      'cache/**',
      'sim-out/**',
      '.deepsec/**',
    ],
  },
});
