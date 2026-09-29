import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['android-browser.spec.mjs'], timeout: 90000, workers: 1,
  reporter: [['list']], use: { channel: 'msedge', headless: true, viewport: { width: 393, height: 800 }, screenshot: 'only-on-failure' }
});
