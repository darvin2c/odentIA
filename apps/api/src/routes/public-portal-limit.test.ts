/**
 * El portal cuenta los intentos de cada dirección por separado, con la misma
 * dirección que las otras rutas públicas (`registrationRemoteAddress`): lo que
 * hace una persona no traba a las demás.
 */
import type { Auth } from "@odentia/auth"
import type { Db } from "@odentia/db"
import { expect, it } from "vitest"
import { createApp } from "../app.js"
import { secretsKeyFromEnv } from "@odentia/services"

it("los intentos de entrar al portal se cuentan por dirección", async () => {
  const app = createApp({
    auth: {} as Auth,
    db: {} as Db,
    ownerDb: {} as Db,
    secretsKey: secretsKeyFromEnv("ee".repeat(32)),
    storage: {} as never,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer: { send: async () => {} },
    listenUrl: "postgres://localhost:5432/dentalagent",
    registrationRemoteAddress: (c) => c.req.header("x-test-address"),
  } as Parameters<typeof createApp>[0])
  const attempt = (address: string) =>
    app.request("/api/public/portal/passkeys/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-address": address },
      body: "{}",
    })
  let last = 0
  for (let index = 0; index < 31; index++) last = (await attempt("198.51.100.1")).status
  expect(last).toBe(429)
  expect((await attempt("198.51.100.2")).status).not.toBe(429)
})
