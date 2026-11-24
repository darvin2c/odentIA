import { defineConfig } from "@playwright/test"
import { ACCOUNT, API_PORT, WEB, WEB_PORT } from "./entorno"

/**
 * El recorrido de gestorIA en un navegador (ADR 0214): su servidor y su base de verdad, con una
 * cuenta y una administración de mentira (`servidor.ts`), y su app compilada como en producción
 * (`vite build` + `vite preview`). Un solo trabajador: los recorridos cambian quién entra.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results",
  reporter: [["list"]],
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "node --import tsx servidor.ts",
      url: `http://127.0.0.1:${API_PORT}/health`,
      timeout: 240_000,
      stdout: "pipe",
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite build --outDir ../../e2e/.web --emptyOutDir && pnpm exec vite preview --outDir ../../e2e/.web --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: "../apps/web",
      url: WEB,
      timeout: 240_000,
      reuseExistingServer: false,
      env: { VITE_API_URL: `http://127.0.0.1:${API_PORT}`, VITE_ACCOUNT_URL: ACCOUNT },
    },
  ],
})
