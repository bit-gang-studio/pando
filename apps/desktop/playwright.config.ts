import { defineConfig, devices } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };
const CI = !!process.env.CI;

// Screen tests: the real frontend in Chromium, with Tauri's invoke mocked (e2e/mock.ts).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  retries: 0,
  reporter: CI ? "github" : "list",
  use: { baseURL: "http://localhost:1498", viewport: { width: 1280, height: 800 } },
  projects: [
    { name: "light", use: { ...devices["Desktop Chrome"], colorScheme: "light" }, testIgnore: /dark\.spec/ },
    { name: "dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" }, testMatch: /dark\.spec/ },
  ],
  webServer: { command: "pnpm exec vite --port 1498 --strictPort", port: 1498, reuseExistingServer: !CI },
});
