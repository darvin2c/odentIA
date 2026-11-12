import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import type { Context, Next } from "hono"
import { Hono } from "hono"
import { expect, it } from "vitest"
import { createAdminFoundersRoute } from "./admin-founders.js"

/**
 * «Ocultar a soporte» es de la administración: soporte recibe 403 con el
 * motivo de ocultar, no el de invitar o descartar. Lo que hace ocultar en la
 * base lo prueba `hideWaitlistFollowUp` en services.
 */
it("soporte no oculta una entrada: 403 con el motivo de ocultar", async () => {
  // Una base que solo abre la transacción: el servicio rechaza por el rol antes de leer.
  const ownerDb = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as Db
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("adminActor", { userId: "staff-1", role: "support" })
    await next()
  })
  app.route("/api/admin/waitlist", createAdminFoundersRoute({ ownerDb, mailer: {} as Mailer, panelUrlOf: () => "https://app.example.test" }))
  const res = await app.request("/api/admin/waitlist/follow-ups/54077c6a-4fa9-42e6-af22-3131017730d6/hide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(res.status).toBe(403)
  expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN", message: "Solo el rol Administración oculta una entrada a soporte" } })
})
