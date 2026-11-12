import { defineConfig } from 'vitest/config'

// The longer runs, which report and gate nothing: `npm run soak:sequences`
export default defineConfig({
  test: {
    include: ['tests/soak/**/*.soak.ts'],
    setupFiles: ['tests/_support/setup.ts'],
    testTimeout: 0,
    hookTimeout: 0,
  },
})
