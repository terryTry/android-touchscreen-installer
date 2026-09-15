import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1180, height: 820 } } },
    { name: 'minimum-window', use: { viewport: { width: 980, height: 680 } } }
  ],
  webServer: {
    command: 'npm run test:e2e:serve',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false
  }
})
