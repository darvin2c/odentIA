/**
 * Reportes: las cuatro preguntas de quien dirige la clínica y la lista detrás
 * de cada cifra. Montaje del padre: `guarded.route("/reports", createReportsRoute(crmDeps))`.
 *
 * Todo es lectura y todo pide `reports.read`: ni caja ni el profesional lo ven.
 * El periodo es una opción cerrada (meses completos) o un rango de días; la sede es opcional.
 */
import { withOrgContext, type Db } from "@odentia/db"
import {
  getReportAdvice,
  getReportAgent,
  getReportAgenda,
  getReportList,
  getReportMoney,
  getReportSales,
  getReportService,
  getReportProfessionals,
  getReportSummary,
  REPORT_LISTS,
  REPORT_PERIOD_PATTERN,
  type ReportQuery,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const reportQuery = z.object({
  period: z.string().regex(REPORT_PERIOD_PATTERN, "Periodo no reconocido"),
  branchId: z.uuid().optional(),
})

export function createReportsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "reports.read"))
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para consultar reportes"), 403)
    await next()
  })

  const read = (path: string, service: (tx: Db, orgId: string, query: ReportQuery) => Promise<unknown>) =>
    app.get(path, async (c) => {
      const { orgId } = orgContextOf(c)
      const parsed = reportQuery.safeParse(c.req.query())
      if (!parsed.success) return validationError(c, parsed.error.issues)
      return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => service(tx, orgId, parsed.data)))
    })

  read("/summary", getReportSummary)
  read("/professionals", getReportProfessionals)
  read("/money", getReportMoney)
  read("/agenda", getReportAgenda)
  read("/sales", getReportSales)
  read("/service", getReportService)

  // Agente: lo pagado a odentIA va solo a quien ve Facturación (propietario o administrador, como su pantalla).
  app.get("/agent", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const billing = memberRole === "owner" || memberRole === "admin"
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getReportAgent(tx, orgId, parsed.data, new Date(), { billing })))
  })

  // Los avisos del Administrador: cada línea exige su permiso, como en Inicio.
  app.get("/advice", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const can = (permission: string): boolean => canAccess(memberRole, permission)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getReportAdvice(tx, orgId, parsed.data, can)))
  })

  app.get("/list/:list", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = reportQuery.extend({ list: z.enum(REPORT_LISTS) }).safeParse({ ...c.req.query(), list: c.req.param("list") })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getReportList(tx, orgId, parsed.data)))
  })

  return app
}
