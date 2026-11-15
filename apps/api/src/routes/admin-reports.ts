import type { Db } from "@odentia/db"
import {
  type AdminActor,
  altaReport,
  FUNNEL_MAX_MONTHS,
  forecastReport,
  funnelReport,
  latestKairosWeekly,
  revenueReport,
  ServiceError,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { runService, validationError } from "./helpers.js"

/**
 * Reportes del ARM (`/api/admin/reports`): el embudo de venta, el alta, los
 * ingresos, la previsión y el resumen de la semana que escribió Kairós. Solo el rol
 * Administración (llevan importes): el servidor lo exige aquí y en cada
 * servicio. Las cifras las pone el cálculo; Kairós solo las cita.
 */
export interface AdminReportsDeps {
  /** Las tablas del ARM viven en `admin`, sin GRANT a la app: solo la conexión propietaria. */
  ownerDb: Db
}

function adminOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Los reportes son de Administración")
  return actor
}

const months = (max: number) =>
  z.coerce
    .number("Los meses son un número")
    .int("Los meses son un número entero")
    .min(1, `Elige de 1 a ${max} meses`)
    .max(max, `Elige de 1 a ${max} meses`)
    .optional()

const funnelQuery = z.object({ months: months(FUNNEL_MAX_MONTHS) })
const revenueQuery = z.object({ months: months(24) })

export function createAdminReportsRoute(deps: AdminReportsDeps) {
  const app = new Hono()

  app.get("/funnel", async (c) => {
    const actor = adminOf(c)
    const parsed = funnelQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { months } = parsed.data
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => funnelReport(tx, actor, months ? { months } : {})),
    )
  })

  app.get("/alta", async (c) => {
    const actor = adminOf(c)
    const parsed = funnelQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { months } = parsed.data
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => altaReport(tx, actor, months ? { months } : {})),
    )
  })

  app.get("/revenue", async (c) => {
    const actor = adminOf(c)
    const parsed = revenueQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { months } = parsed.data
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) =>
        revenueReport(tx, actor, new Date(), months ? { months } : {}),
      ),
    )
  })

  app.get("/forecast", async (c) => {
    const actor = adminOf(c)
    return runService(c, 200, () => deps.ownerDb.transaction((tx) => forecastReport(tx, actor)))
  })

  // El texto de Kairós de la última semana escrita, con las cifras que citó; null si aún no hay.
  app.get("/weekly", async (c) => {
    const actor = adminOf(c)
    return runService(c, 200, () => deps.ownerDb.transaction((tx) => latestKairosWeekly(tx, actor)))
  })

  return app
}
