import { afterEach, expect, it, vi } from "vitest"

/** Lo mínimo para que la API arranque; el resto tiene valores por defecto. */
const BASE = {
  DATABASE_URL: "postgres://owner@127.0.0.1/odentia",
  APP_DATABASE_URL: "postgres://app@127.0.0.1/odentia",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://api.example.test",
  WEB_URL: "https://app.example.test",
  ADMIN_URL: "https://admin.example.test",
  COOKIE_DOMAIN: "example.test",
  TRUSTED_ORIGINS: "https://app.example.test",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_FROM: "odentIA <no-reply@example.test>",
  S3_ENDPOINT: "https://s3.example.test",
  S3_ACCESS_KEY: "a",
  S3_SECRET_KEY: "b",
  S3_BUCKET: "avatars",
  S3_ATTACHMENTS_BUCKET: "attachments",
  S3_PUBLIC_URL: "https://s3.example.test/avatars",
  SECRETS_KEY: "ee".repeat(32),
  LLM_MODEL: "fake",
  NODE_ENV: "production",
}

/** Carga `env.ts` como al arrancar: un error de variables termina el proceso. */
async function boot(vars: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value)
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
  const logged = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    return { env: (await import("./env.js")).env, logged }
  } catch (error) {
    return { error, logged }
  } finally {
    exit.mockRestore()
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it("en producción con canales reales la API no arranca con el modelo de demostración", async () => {
  const { error, logged } = await boot({ ...BASE, CHANNEL_VALIDATE_EXTERNAL: "true" })
  expect(String(error)).toContain("exit 1")
  expect(logged.mock.calls[0]?.[1]).toMatchObject({ LLM_MODEL: [expect.stringContaining("modelo de demostración")] })
})

it("una vista previa (canales simulados), desarrollo y pruebas sí arrancan con él", async () => {
  expect((await boot({ ...BASE, CHANNEL_VALIDATE_EXTERNAL: "false" })).env).toMatchObject({ LLM_MODEL: "fake" })
  expect((await boot({ ...BASE, CHANNEL_VALIDATE_EXTERNAL: "true", NODE_ENV: "test" })).env).toMatchObject({ LLM_MODEL: "fake" })
  // Producción con un modelo real arranca.
  expect((await boot({ ...BASE, CHANNEL_VALIDATE_EXTERNAL: "true", LLM_MODEL: "" })).env).toBeDefined()
})
