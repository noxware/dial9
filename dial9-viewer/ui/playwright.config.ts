import { defineConfig } from "playwright/test";

const port = 43_911;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL,
    viewport: { width: 1_800, height: 1_200 },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/new/viewer.html`,
    reuseExistingServer: false,
  },
});
