/**
 * Revisión de las reglas clínicas del 18 nov: un id de consentimiento que no es UUID no existe. Se
 * responde 404, como en las fichas, en vez de dejar que la base lo rechace como un error interno.
 * La base no se toca: la respuesta sale antes.
 */
import type { Db } from "@odentia/db"
import { Hono, type Context, type Next } from "hono"
import { expect, it } from "vitest"
import { createClinicalFormsRoute } from "./clinical-forms.js"
import type { CrmDeps } from "./helpers.js"

const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("La base no se toca con un id que no existe")
    },
  },
) as Db

function buildApp(): Hono {
  const deps = {
    db: untouchable,
    secretsKey: new Uint8Array(32),
    storage: {},
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  } as unknown as CrmDeps
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", "owner")
    await next()
  })
  app.route("/clinical-forms", createClinicalFormsRoute(deps))
  return app
}

it("lo que cuelga de un consentimiento con un id que no es UUID responde 404, también «Riesgos propios»", async () => {
  const app = buildApp()
  const json = { "content-type": "application/json" }
  const calls: [string, string, unknown?][] = [
    [
      "PUT",
      "/clinical-forms/consents/no-es-un-id/personal-risks",
      { personalRisks: "Toma apixabán." },
    ],
    ["POST", "/clinical-forms/consents/no-es-un-id/sign", {}],
    ["POST", "/clinical-forms/consents/no-es-un-id/send-link", {}],
    ["POST", "/clinical-forms/consents/no-es-un-id/show-link"],
    ["POST", "/clinical-forms/consents/no-es-un-id/confirm", {}],
    ["POST", "/clinical-forms/consents/no-es-un-id/pdf"],
    ["GET", "/clinical-forms/consents/no-es-un-id/print"],
    ["POST", "/clinical-forms/consents/no-es-un-id/cancel", { reason: "Duplicado" }],
    ["POST", "/clinical-forms/consents/no-es-un-id/revoke", { reason: "Cambio" }],
    ["GET", "/clinical-forms/consents/no-es-un-id/history"],
  ]
  for (const [method, path, body] of calls) {
    const response = await app.request(path, {
      method,
      headers: json,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect([path, response.status]).toEqual([path, 404])
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Consentimiento no encontrado" },
    })
  }
})
