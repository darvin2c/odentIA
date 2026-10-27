import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { DEMO_MONTHS, DEMO_SIZES } from "@odentia/db/schema/admin-demos"
import { deleteDemo, getDemoOfOrganization, getDemoOptions, listDemos, markDemoOpened, requestDemo, resetDemo } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { adminContextOf } from "../lib/admin-context.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Las demos para presentar (ADR 0096): pedirlas, ver cómo van, volver a
 * empezar y borrarlas. Las arma el worker. Crear, volver a empezar y borrar
 * son de la administración (el servicio lo exige); soporte las lee.
 */
const demoInput = z
  .object({
    product: z.enum(CLINICAL_PRODUCTS),
    kind: z.string().trim().min(1).max(60),
    size: z.enum(DEMO_SIZES),
    months: z.coerce.number().int().refine((value) => (DEMO_MONTHS as readonly number[]).includes(value), "6, 12 o 24 meses"),
    countryCode: z.enum(["PE", "CO", "MX"]),
    name: z.string().trim().min(3).max(80),
    presenterUserId: z.string().trim().min(1).max(200),
  })
  .strict()

const deleteInput = z.object({ confirmName: z.string().max(120) }).strict()

export function createAdminDemosRoute(deps: Pick<AppDeps, "ownerDb" | "storage">) {
  const app = new Hono()
  const owner = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => deps.ownerDb.transaction((tx) => fn(tx as Db))

  app.get("/options", (c) => runService(c, 200, () => owner((tx) => getDemoOptions(tx))))
  app.get("/", (c) => runService(c, 200, () => owner(async (tx) => ({ items: await listDemos(tx) }))))
  app.get("/organization/:orgId", (c) => runService(c, 200, () => owner(async (tx) => ({ demo: await getDemoOfOrganization(tx, c.req.param("orgId")) }))))

  app.post("/", async (c) => {
    const actor = adminContextOf(c)
    const parsed = demoInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => owner((tx) => requestDemo(tx, actor, parsed.data)))
  })

  app.post("/:id/reset", (c) => runService(c, 200, () => owner((tx) => resetDemo(tx, adminContextOf(c), c.req.param("id")))))

  app.post("/:id/open", (c) =>
    runService(c, 200, async () => {
      await owner((tx) => markDemoOpened(tx, c.req.param("id")))
      return { ok: true }
    }),
  )

  app.delete("/:id", async (c) => {
    const actor = adminContextOf(c)
    const parsed = deleteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const purged = await owner((tx) => deleteDemo(tx, actor, c.req.param("id"), parsed.data.confirmName))
      // Ya confirmado el borrado: lo que la clínica tenía guardado se quita después.
      for (const key of purged.storageKeys) await deps.storage.deleteAttachment(key).catch(() => undefined)
      return c.json({ data: { ok: true } })
    } catch (error) {
      const response = serviceErrorResponse(c, error)
      if (response) return response
      throw error
    }
  })

  return app
}
