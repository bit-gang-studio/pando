import { defineConfig, devices } from "@playwright/test";

// Real-git browser tests: the real frontend, the real desktop commands (via
// the dev bridge) and real git on a throwaway repo. Nothing opens on screen.
// Run: pnpm exec playwright test -c e2e-real
declare const process: { env: Record<string, string | undefined>; cwd(): string };
export const BASE = process.env.PANDO_E2E_BASE ?? "/tmp/pando-e2e-real";

export default defineConfig({
  testDir: ".",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
  use: { baseURL: "http://localhost:1497", viewport: { width: 1400, height: 850 }, ...devices["Desktop Chrome"] },
  webServer: [
    { command: "pnpm exec vite --port 1497 --strictPort", port: 1497, reuseExistingServer: false, cwd: ".." },
    {
      command: `PANDO_CONFIG_DIR=${BASE}/config cargo run -q -p pando-desktop --example bridge -- 4599`,
      port: 4599,
      reuseExistingServer: false,
      timeout: 300_000,
      cwd: "../../..",
    },
  ],
});
