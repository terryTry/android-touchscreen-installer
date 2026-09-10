import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      reporter: ['text', 'html']
    },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true
  },
  resolve: {
    alias: {
      '@renderer': new URL('./src/renderer/src', import.meta.url).pathname,
      '@shared': new URL('./src/shared', import.meta.url).pathname
    }
  }
})
