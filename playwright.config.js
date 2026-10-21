import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 }
  },
  webServer: {
    command: 'node tools/serve.mjs',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: false
  },
  reporter: 'list'
});
