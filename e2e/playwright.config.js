// EzDAQ EPS UI regression selftest — Playwright configuration.
// Runs the standalone demo (demo/index.html) against three browser targets:
//   1. chromium  : Playwright-managed Chromium (headless by default)
//   2. msedge    : installed Microsoft Edge via channel
//   3. chrome    : Chrome for Testing unpacked under e2e/.browsers (if present)
const fs = require('fs');
const path = require('path');

const chromeExe = path.join(__dirname, '.browsers', 'chrome-win64', 'chrome.exe');
const hasChromeForTesting = fs.existsSync(chromeExe);

module.exports = {
  testDir: './tests',
  timeout: 45_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'file://' + path.join(__dirname, '..').replace(/\\/g, '/') + '/demo/',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'msedge', use: { browserName: 'chromium', channel: 'msedge' } },
    ...(hasChromeForTesting
      ? [{ name: 'chrome', use: { browserName: 'chromium', executablePath: chromeExe } }]
      : []),
  ],
};
