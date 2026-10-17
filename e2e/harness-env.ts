import { join, resolve } from "node:path"

/**
 * Runtime efímero de una ejecución E2E e imágenes/constantes del harness.
 *
 * El supervisor (`run.ts`) crea el `HarnessRuntime` con puertos reservados y
 * un directorio privado; `startStack` (`stack.ts`) rellena los endpoints de
 * infraestructura tras arrancar los contenedores. Sin puertos fijos ni
 * valores del entorno dev: todo sale del runtime de esta ejecución.
 */

/** Raíz del repo. */
export const ROOT = resolve(import.meta.dirname, "..")
/** CLI de portless (dependencia del workspace). */
export const PORTLESS_CLI = join(ROOT, "node_modules", "portless", "dist", "cli.js")

/** Runtime de una ejecución: identificadores y puertos propios del run. */
export type HarnessRuntime = {
  runId: string
  stateDir: string
  baseDomain: string
  proxyPort: number
  appPorts: { api: number; panel: number; platform: number; admin: number }
  postgres?: { host: string; port: number }
  minio?: { host: string; port: number }
  mailpit?: { host: string; httpPort: number; smtpPort: number }
}

/** Etiqueta común de los contenedores del harness (nunca toca el dev). */
export const E2E_LABEL = "odentia.e2e"
/** Etiqueta con el id de la ejecución (`odentia.e2e.run=<runId>`). */
export const E2E_RUN_LABEL = "odentia.e2e.run"

/** PostgreSQL con pgmq/pg_cron (imagen propia del repo). */
export const PG_IMAGE = "dentalagent-postgres:18.6"
/** MinIO publicado y verificado en el runtime local. */
export const MINIO_IMAGE =
  "quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"
/** Mailpit publicado y verificado en el runtime local. */
export const MAILPIT_IMAGE =
  "docker.io/axllent/mailpit@sha256:3856f9327f3f228afe8c4ce2dcca3cb2aa00f6ec60b569f36483f7ebb1ff44f7"

export const AVATARS_BUCKET = "dentalagent-e2e"
export const ATTACHMENTS_BUCKET = "dentalagent-e2e-attachments"

/**
 * Variables que nunca deben heredarse del entorno del desarrollador en los
 * hijos del harness (credenciales opcionales de proveedores externos). El
 * supervisor las elimina del env de cada proceso que arranca.
 */
export const E2E_SCRUB_ENV_KEYS: readonly string[] = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_OPENAI_API_KEY",
  "LLM_OPENAI_BASE_URL",
  "LLM_ANTHROPIC_API_KEY",
  "LLM_ANTHROPIC_BASE_URL",
  "JEV_API_KEY",
  "JEV_BASE_URL",
  "OPENAI_DECISIONS_API_KEY",
  "OPENAI_DECISIONS_BASE_URL",
  "TRANSCRIBE_MODEL",
  "TRANSCRIBE_API_KEY",
  "TRANSCRIBE_BASE_URL",
]

const requireInfra = (
  runtime: HarnessRuntime,
): {
  postgres: { host: string; port: number }
  minio: { host: string; port: number }
  mailpit: { host: string; httpPort: number; smtpPort: number }
} => {
  const { postgres, minio, mailpit } = runtime
  const faltantes: string[] = []
  if (!postgres) faltantes.push("postgres")
  if (!minio) faltantes.push("minio")
  if (!mailpit) faltantes.push("mailpit")
  if (!postgres || !minio || !mailpit) {
    throw new Error(
      `El entorno E2E está incompleto: falta la infraestructura (${faltantes.join(", ")}). ` +
        `Arranca primero los contenedores con startStack; E2E no utiliza el entorno dev.`,
    )
  }
  return { postgres, minio, mailpit }
}

/** Origen público base (`https://odentia.<TLD>:<proxyPort>`). */
export function baseOrigin(runtime: HarnessRuntime): string {
  return `https://${runtime.baseDomain}:${runtime.proxyPort}`
}

/** URL de la base temporal como owner (migraciones y catálogos). */
export function ownerDatabaseUrl(runtime: HarnessRuntime): string {
  const pg = requireInfra(runtime).postgres
  return `postgres://dentalagent:dentalagent@${pg.host}:${pg.port}/dentalagent`
}

/** URL de la base temporal con el rol de la aplicación. */
export function appDatabaseUrl(runtime: HarnessRuntime): string {
  const pg = requireInfra(runtime).postgres
  return `postgres://dentalagent_app:dentalagent_app@${pg.host}:${pg.port}/dentalagent`
}

/**
 * Env completo y puro de la ejecución: todo sale del runtime, nada del dev.
 * Exige los tres endpoints de infraestructura; lanza error si falta alguno.
 */
export function stackEnv(runtime: HarnessRuntime): Record<string, string> {
  const { postgres, minio, mailpit } = requireInfra(runtime)
  const tld = runtime.baseDomain.replace(/^[^.]+\./, "")
  const base = `https://${runtime.baseDomain}:${runtime.proxyPort}`
  const api = `https://api.${runtime.baseDomain}:${runtime.proxyPort}`
  const panel = `https://app.${runtime.baseDomain}:${runtime.proxyPort}`
  const s3Endpoint = `http://${minio.host}:${minio.port}`
  const portlessStateDir = join(runtime.stateDir, "portless")
  return {
    PORTLESS_STATE_DIR: portlessStateDir,
    PORTLESS_TLD: tld,
    PORTLESS_PORT: String(runtime.proxyPort),
    PORTLESS_HTTPS: "1",
    PORTLESS_WILDCARD: "1",
    DATABASE_URL: `postgres://dentalagent:dentalagent@${postgres.host}:${postgres.port}/dentalagent`,
    APP_DATABASE_URL: `postgres://dentalagent_app:dentalagent_app@${postgres.host}:${postgres.port}/dentalagent`,
    BETTER_AUTH_SECRET: "e2e-only-secret-0123456789abcdef0123456789",
    BETTER_AUTH_URL: api,
    WEB_URL: panel,
    ADMIN_URL: `https://admin.${runtime.baseDomain}:${runtime.proxyPort}`,
    COOKIE_DOMAIN: runtime.baseDomain,
    TRUSTED_ORIGINS: [base, panel, api, `https://*.${runtime.baseDomain}:${runtime.proxyPort}`].join(
      ",",
    ),
    SMTP_HOST: mailpit.host,
    SMTP_PORT: String(mailpit.smtpPort),
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: `odentIA <no-reply@${runtime.baseDomain}>`,
    SUPPORT_INBOX_EMAIL: `soporte@${runtime.baseDomain}`,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: "auto",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
    S3_BUCKET: AVATARS_BUCKET,
    S3_ATTACHMENTS_BUCKET: ATTACHMENTS_BUCKET,
    S3_PUBLIC_URL: `${s3Endpoint}/${AVATARS_BUCKET}`,
    SECRETS_KEY: "b895edcf574a7ca79434e50769e9ded6daace1636bc40d71f1310c3f43c5982b",
    CHANNEL_VALIDATE_EXTERNAL: "false",
    CHANNEL_SENDER_MODE: "mock",
    LLM_MODEL: "fake",
    // Ventana mínima: ejercita la cola con retardo sin alargar los recorridos.
    AGENT_BURST_WINDOW_SECONDS: "1",
    VITE_API_URL: api,
    VITE_BASE_DOMAIN: runtime.baseDomain,
    VITE_BASE_PORT: String(runtime.proxyPort),
    E2E_SCHEME: "https",
    E2E_BASE_DOMAIN: runtime.baseDomain,
    E2E_PORT: String(runtime.proxyPort),
    E2E_RUN_ID: runtime.runId,
    E2E_STATE_DIR: runtime.stateDir,
    NODE_EXTRA_CA_CERTS: join(portlessStateDir, "ca.pem"),
    MAILPIT_API: `http://${mailpit.host}:${mailpit.httpPort}/api/v1`,
  }
}
