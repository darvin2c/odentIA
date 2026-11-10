import { defineConfig } from "@playwright/test"
import { baseUrl, RUN_ID } from "./env"

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: `test-results/${RUN_ID}/playwright`,
  reporter: [["list"], ["json", { outputFile: `test-results/${RUN_ID}/results.json` }]],
  use: {
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Sin GPU, la escena 3D de las pantallas de acceso se dibuja por software y,
    // en movimiento, ocupa la CPU entera: con movimiento reducido queda quieta.
    // La opción del navegador alcanza también a los contextos creados a mano.
    reducedMotion: "reduce",
    // El certificado del proxy es de la corrida: `ignoreHTTPSErrors` no alcanza al service
    // worker (la app instalable, ADR 0177), que Chrome no registra con un certificado propio.
    launchOptions: { args: ["--force-prefers-reduced-motion", "--ignore-certificate-errors"] },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})
