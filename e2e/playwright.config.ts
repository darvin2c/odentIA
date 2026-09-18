import { defineConfig } from "@playwright/test"
import { baseUrl } from "./env"
import { APP_PORTS, PORTLESS_CLI, ROOT, stackEnv } from "./harness-env"
import { ensureStack } from "./stack"

/**
 * Modo por defecto: contra el stack dev ya levantado (`pnpm dev`), como antes.
 * Con `E2E_HARNESS=1` el harness levanta su propia infraestructura efímera
 * (contenedores en puertos fijos, proxy portless en un namespace aparte y sus
 * servidores), de modo que no toca ni depende de lo que tengas corriendo.
 */
const harness = process.env.E2E_HARNESS === "1"

/**
 * La infraestructura se levanta al cargar la config: Playwright arranca
 * `webServer` ANTES del `globalSetup`, y las apps necesitan la base y el proxy
 * ya vivos. `ensureStack` es idempotente entre procesos (marcador + lock).
 */
if (harness) await ensureStack()

const env = harness ? stackEnv() : {}
/**
 * La config también se carga dentro de cada worker de Playwright: publicar el
 * env del harness en `process.env` es lo que hace que los specs (URLs, mailpit)
 * apunten a la infraestructura efímera y no a la del dev.
 */
Object.assign(process.env, env)
const timeout = 120_000

/**
 * El harness arranca las apps con el env de sus contenedores efímeros: nunca
 * reutiliza (ni pisa) el stack dev del operador, que vive en otro namespace.
 *
 * Readiness por `wait.stdout` y no por `url`: el probe de Playwright corre en
 * Node, que no resuelve los subdominios `*.localhost` (los specs ya lo
 * documentan para el request-context). Los banners de arranque son estables.
 */
const webServer = harness
  ? [
      {
        command: `node ${PORTLESS_CLI} --force --app-port ${APP_PORTS.api} api.odentia pnpm run dev:app`,
        cwd: `${ROOT}/apps/api`,
        wait: { stdout: /api listening on/ },
        env,
        timeout,
        reuseExistingServer: false,
        stdout: "pipe",
        stderr: "pipe",
      },
      {
        command: `node ${PORTLESS_CLI} --force --app-port ${APP_PORTS.worker} worker pnpm run dev:app`,
        cwd: `${ROOT}/apps/worker`,
        wait: { stdout: /worker: consumiendo/ },
        env,
        timeout,
        reuseExistingServer: false,
        stdout: "pipe",
        stderr: "pipe",
      },
      {
        command: `node ${PORTLESS_CLI} --force --app-port ${APP_PORTS.panel} app.odentia pnpm run dev:app`,
        cwd: `${ROOT}/apps/panel`,
        wait: { stdout: /Local:/ },
        env,
        timeout,
        reuseExistingServer: false,
        stdout: "pipe",
        stderr: "pipe",
      },
      {
        command: `node ${PORTLESS_CLI} --force --app-port ${APP_PORTS.platform} odentia pnpm run dev:app`,
        cwd: `${ROOT}/apps/platform`,
        wait: { stdout: /Local:/ },
        env,
        timeout,
        reuseExistingServer: false,
        stdout: "pipe",
        stderr: "pipe",
      },
    ]
  : undefined

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1, // comparten Mailpit
  globalTeardown: harness ? "./global-teardown.ts" : undefined,
  use: {
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer,
})