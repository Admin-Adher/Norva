'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'partners.spec.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['line']] : [['list']],
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    browserName: 'chromium',
    locale: 'en-US',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'android-mobile-chromium',
      use: {
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        hasTouch: true,
        isMobile: true,
        userAgent:
          'Mozilla/5.0 (Linux; Android 16; Norva E2E) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
      },
    },
  ],
});
