import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:['cloud-browser.spec.mjs'],timeout:90000,workers:1,
  outputDir:'test-results/cloud-browser',
  reporter:[['list']],
  use:{channel:'msedge',headless:true,viewport:{width:1365,height:900},screenshot:'only-on-failure'}
});
