import { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: './tests',
  timeout: 30000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/metrics.json' }]
  ],
  use: {
    baseURL: 'https://pay.dev.q1.peekup.asia',
    extraHTTPHeaders: {
      'Accept': 'application/json',
    },
  },
  projects: [
    {
      name: 'API Testing',
      testMatch: /.*\.test\.ts/,
    },
  ],
};

export default config;