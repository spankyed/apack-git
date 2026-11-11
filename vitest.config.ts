import { defineConfig } from 'vitest/config'

// Every spec runs a real git in a throwaway repository, and some wait on the platform's file events. The
// timeouts are a detector of a hang, set far past what any case takes on a busy runner: nothing is decided by
// how long a case took.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/_support/setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
