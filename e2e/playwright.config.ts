import { defineConfig } from "@playwright/test"
import { baseUrl, RUN_ID } from "./env"

/**
 * Los recorridos de las clínicas que también abren pantallas de la administración
 * (`hostUrl("admin")`, `ADMIN`, `enterAdmin`): corren con los de la administración.
 * Un recorrido nuevo que la abra se suma aquí; `admin-scope.test.ts` lo exige.
 */
export const ALSO_ADMIN = [
  "**/e2e/cobro.spec.ts",
  "**/e2e/condiciones-comerciales.spec.ts",
  "**/e2e/demos.spec.ts",
  "**/e2e/libro-reclamaciones.spec.ts",
  "**/e2e/loading-unknowns.spec.ts",
  "**/e2e/precio-negociado.spec.ts",
  "**/e2e/spam-y-cobros.spec.ts",
]

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
  // Cada sistema con sus recorridos (lienzo A, paso 0): las clínicas aquí y la
  // administración en `admin/e2e`. Comparten este arnés y el mismo entorno. El proyecto
  // `admin` es lo que corre un cambio solo de la administración: sus recorridos y los de
  // aquí que también abren sus pantallas, que salen del de las clínicas para no repetirse.
  projects: [
    { name: "chromium", testIgnore: ALSO_ADMIN, use: { browserName: "chromium" } },
    { name: "admin", testDir: "..", testMatch: ["admin/e2e/**/*.spec.ts", ...ALSO_ADMIN], use: { browserName: "chromium" } },
  ],
})
