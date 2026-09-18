import { join, resolve } from "node:path"

/**
 * Namespace, puertos y env del entorno de e2e — fuente única para el harness
 * (`stack.ts`), la config de Playwright y los tests (`env.ts`).
 *
 * Los tests nunca usan el dominio del dev (`odentia.localhost:443`): el harness
 * levanta infraestructura efímera (testcontainers), su propio proxy portless
 * (`PORTLESS_STATE_DIR`/`PORTLESS_TLD`/`PORTLESS_PORT`) y sus servidores.
 *
 * Los puertos de host son fijos para que el env sea estático: `webServer`
 * arranca ANTES del `globalSetup`, así que la config no puede esperar valores
 * resueltos por los contenedores. Los restos de una corrida interrumpida se
 * reapen por etiqueta (`HARNESS_LABEL`), nunca por puerto.
 */
const num = (value: string | undefined, fallback: number): string =>
  value && Number.isInteger(Number(value)) ? value : String(fallback)

export const HARNESS_SCHEME = "https"
/** TLD que consume portless (`<nombre-de-app>.<TLD>`). */
export const HARNESS_TLD = "e2e.localhost"
/**
 * Dominio base real de los hosts: portless compone `<name>.<TLD>` con los
 * nombres del `portless.json` raíz (`odentia`, `api.odentia`, `app.odentia`),
 * así que el dominio del tenant es `odentia.e2e.localhost` y los subdominios
 * de organización cuelgan de él (`<slug>.odentia.e2e.localhost`).
 */
export const HARNESS_DOMAIN = `odentia.${HARNESS_TLD}`
/** Etiqueta de los contenedores del harness (permite reaparlos sin tocar el dev). */
export const HARNESS_LABEL = "odentia.e2e"
/** Puerto del proxy del harness (el dev usa 443). */
export const HARNESS_PORT = num(process.env.E2E_PROXY_PORT, 4463)
/**
 * Puertos fijos de las apps del harness (`PORTLESS_APP_PORT`). Fijos para poder
 * limpiar procesos de corridas interrumpidas por puerto, sin tocar el dev.
 */
export const APP_PORTS = {
  api: num(process.env.E2E_API_PORT, 4601),
  panel: num(process.env.E2E_PANEL_PORT, 4602),
  platform: num(process.env.E2E_PLATFORM_PORT, 4603),
  worker: num(process.env.E2E_WORKER_PORT, 4604),
} as const
/** Puertos de host de la infraestructura efímera. */
export const PG_PORT = num(process.env.E2E_PG_PORT, 55432)
export const MINIO_PORT = num(process.env.E2E_MINIO_PORT, 59000)
export const MAILPIT_HTTP_PORT = num(process.env.E2E_MAILPIT_HTTP_PORT, 58025)
export const MAILPIT_SMTP_PORT = num(process.env.E2E_MAILPIT_SMTP_PORT, 51025)

/** Raíz del repo y estado del harness. */
export const ROOT = resolve(import.meta.dirname, "..")
/** Estado del proxy (routes + CA propios); se limpia en cada corrida. */
export const STATE_DIR = join(ROOT, ".e2e-portless")
/** CLI de portless (dependencia del workspace). */
export const PORTLESS_CLI = join(ROOT, "node_modules", "portless", "dist", "cli.js")

export const PG_IMAGE = "dentalagent-postgres:18.6"
export const MINIO_IMAGE = "quay.io/minio/minio:latest"
export const MAILPIT_IMAGE = "axllent/mailpit:latest"
export const AVATARS_BUCKET = "dentalagent-e2e"
export const ATTACHMENTS_BUCKET = "dentalagent-e2e-attachments"

export const baseOrigin = `${HARNESS_SCHEME}://${HARNESS_DOMAIN}:${HARNESS_PORT}`
export const apiOrigin = `${HARNESS_SCHEME}://api.${HARNESS_DOMAIN}:${HARNESS_PORT}`
export const panelOrigin = `${HARNESS_SCHEME}://app.${HARNESS_DOMAIN}:${HARNESS_PORT}`
export const minioEndpoint = `http://127.0.0.1:${MINIO_PORT}`
export const mailpitApi = `http://127.0.0.1:${MAILPIT_HTTP_PORT}/api/v1`
export const ownerDatabaseUrl = `postgres://dentalagent:dentalagent@127.0.0.1:${PG_PORT}/dentalagent`
export const appDatabaseUrl = `postgres://dentalagent_app:dentalagent_app@127.0.0.1:${PG_PORT}/dentalagent`

/** Env completo: lo usa `webServer` (apps) y la config lo publica a los workers. */
export function stackEnv(): Record<string, string> {
  return {
    PORTLESS_STATE_DIR: STATE_DIR,
    PORTLESS_TLD: HARNESS_TLD,
    PORTLESS_PORT: HARNESS_PORT,
    PORTLESS_WILDCARD: "1",
    DATABASE_URL: ownerDatabaseUrl,
    APP_DATABASE_URL: appDatabaseUrl,
    BETTER_AUTH_SECRET: "e2e-only-secret-0123456789abcdef0123456789",
    BETTER_AUTH_URL: apiOrigin,
    WEB_URL: panelOrigin,
    COOKIE_DOMAIN: HARNESS_DOMAIN,
    TRUSTED_ORIGINS: [
      baseOrigin,
      panelOrigin,
      apiOrigin,
      `${HARNESS_SCHEME}://*.${HARNESS_DOMAIN}:${HARNESS_PORT}`,
    ].join(","),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: MAILPIT_SMTP_PORT,
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: `odentIA <no-reply@${HARNESS_DOMAIN}>`,
    S3_ENDPOINT: minioEndpoint,
    S3_REGION: "auto",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
    S3_BUCKET: AVATARS_BUCKET,
    S3_ATTACHMENTS_BUCKET: ATTACHMENTS_BUCKET,
    S3_PUBLIC_URL: `${minioEndpoint}/${AVATARS_BUCKET}`,
    SECRETS_KEY: "b895edcf574a7ca79434e50769e9ded6daace1636bc40d71f1310c3f43c5982b",
    CHANNEL_VALIDATE_EXTERNAL: "false",
    CHANNEL_SENDER_MODE: "mock",
    LLM_MODEL: "fake",
    VITE_API_URL: apiOrigin,
    VITE_BASE_DOMAIN: HARNESS_DOMAIN,
    VITE_BASE_PORT: HARNESS_PORT,
    E2E_SCHEME: HARNESS_SCHEME,
    E2E_BASE_DOMAIN: HARNESS_DOMAIN,
    E2E_PORT: HARNESS_PORT,
    MAILPIT_API: mailpitApi,
  }
}