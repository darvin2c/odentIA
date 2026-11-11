import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import type { Storage } from "@odentia/services"
import type { Context, Next } from "hono"
import { Hono } from "hono"
import { expect, it } from "vitest"
import { createSaasBillingRoute } from "./saas-billing.js"

/**
 * «Rechazar» un comprobante pendiente es de la administración (C11): soporte
 * recibe 403 y el motivo se valida antes de tocar la base. Lo que hace el
 * rechazo en la base lo prueba `rejectSaasReceipt` en services.
 */
function appAs(role: "admin" | "support") {
  const touched: string[] = []
  // Una base que falla si alguien la toca: estas respuestas salen antes de leerla.
  const ownerDb = new Proxy(
    {},
    {
      get: (_target, key) => {
        touched.push(String(key))
        throw new Error("No debía tocar la base")
      },
    },
  ) as Db
  const app = new Hono()
  // Lo que deja `requireAdminContext` cuando la sesión y el segundo factor del personal pasan.
  app.use("*", async (c: Context, next: Next) => {
    c.set("adminActor", { userId: "staff-1", role })
    await next()
  })
  app.route("/api/admin/billing", createSaasBillingRoute({ ownerDb, storage: {} as Storage, mailer: {} as Mailer }))
  const reject = (body: unknown) =>
    app.request("/api/admin/billing/payments/pago-1/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { reject, touched }
}

it("soporte no rechaza comprobantes: 403 sin tocar la base", async () => {
  const { reject, touched } = appAs("support")
  const res = await reject({ organizationId: "org-1", reason: "No se ve el número de operación" })
  expect(res.status).toBe(403)
  expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN", message: "Solo administración rechaza comprobantes" } })
  expect(touched).toEqual([])
})

it("el motivo es obligatorio y va de 1 a 500 caracteres, junto a su campo", async () => {
  const { reject, touched } = appAs("admin")
  const empty = await reject({ organizationId: "org-1", reason: "   " })
  expect(empty.status).toBe(400)
  expect(await empty.json()).toMatchObject({ error: { code: "VALIDATION", fields: { reason: "Escribe el motivo" } } })
  const long = await reject({ organizationId: "org-1", reason: "x".repeat(501) })
  expect(long.status).toBe(400)
  expect(await long.json()).toMatchObject({ error: { fields: { reason: "Escribe el motivo en 500 caracteres como mucho" } } })
  expect(touched).toEqual([])
})
