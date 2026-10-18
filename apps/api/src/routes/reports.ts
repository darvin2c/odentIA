/**
 * Reportes: las cuatro preguntas de quien dirige la clínica y la lista detrás
 * de cada cifra. Montaje del padre: `guarded.route("/reports", createReportsRoute(crmDeps))`.
 *
 * Todo es lectura y todo pide `reports.read`: ni caja ni el profesional lo ven.
 * El periodo es una opción cerrada (meses completos) o un rango de días; la sede es opcional.
 */
import { withOrgContext, type Db } from "@odentia/db"
import {
  getPatientReportList,
  getReportAdvice,
  getReportAgenda,
  getReportFunnel,
  getReportList,
  getReportMoney,
  getReportPatients,
  getReportSales,
  getReportService,
  getReportProfessionals,
  getReportSummary,
  isPatientReportList,
  PATIENT_REPORT_LISTS,
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
  read("/patients", getReportPatients)
  read("/funnel", getReportFunnel)

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
    const parsed = reportQuery.extend({ list: z.enum([...REPORT_LISTS, ...PATIENT_REPORT_LISTS]) }).safeParse({ ...c.req.query(), list: c.req.param("list") })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { list, ...query } = parsed.data
    // Las listas de Pacientes son de personas (algunas aún no son pacientes): las arma su propio servicio.
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx): Promise<unknown> =>
        isPatientReportList(list) ? getPatientReportList(tx, orgId, { ...query, list }) : getReportList(tx, orgId, { ...query, list }),
      ),
    )
  })

  return app
}
