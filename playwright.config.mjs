import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['browser.spec.mjs', 'cli-browser.spec.mjs', 'accounts-browser.spec.mjs', 'web-lifecycle.spec.mjs'], timeout: 90000, workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-results.json' }]],
  use: { channel: 'msedge', headless: true, viewport: { width: 1365, height: 900 }, screenshot: 'only-on-failure' }
});
