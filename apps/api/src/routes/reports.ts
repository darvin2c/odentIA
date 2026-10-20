/**
 * Reportes: las cuatro preguntas de quien dirige la clínica y la lista detrás
 * de cada cifra. Montaje del padre: `guarded.route("/reports", createReportsRoute(crmDeps))`.
 *
 * Todo pide `reports.read`: ni caja ni el profesional lo ven. El periodo es una
 * opción cerrada (meses completos) o un rango de días; la sede es opcional.
 * Además: preguntarle a Argos (ADR 0070), las respuestas fijadas, las metas,
 * el resumen del lunes de cada persona y «Descargar» en CSV (ADR 0071).
 */
import { asAdminDecider, createAdminDecisionModel, meterAiUse, type PlatformDecisions, type PlatformLlm } from "@odentia/agent"
import { seesBilling } from "@odentia/auth/permissions"
import { withOrgContext, type Db } from "@odentia/db"
import {
  answerReportQuery,
  FIGURE_GROUPS,
  getAgendaReport,
  getPatientReportList,
  getReportAdvice,
  getReportAgent,
  getReportCommissions,
  getReportDigest,
  getReportFinance,
  getReportFunnel,
  getReportOutlook,
  getReportPromotions,
  getReportList,
  getReportPatients,
  getReportProfessionals,
  getReportSummary,
  interpretReportQuestion,
  isPatientReportList,
  keywordReportDecider,
  listReportPins,
  PATIENT_REPORT_LISTS,
  pinReportAnswer,
  prepareReportQuestion,
  recordReportQuestionFailure,
  REPORT_ASK_WORDS,
  REPORT_GOAL_METRICS,
  REPORT_LISTS,
  REPORT_PERIOD_PATTERN,
  reportAnswerCsv,
  reportCommissionsCsv,
  reportListCsv,
  reportProfessionalsCsv,
  type CsvFile,
  type ReportInterpretationResult,
  type ReportQuery,
  resolveReportQuestion,
  ServiceError,
  setReportDigest,
  setReportGoal,
  unpinReportAnswer,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const reportQuery = z.object({
  period: z.string().regex(REPORT_PERIOD_PATTERN, "Periodo no reconocido"),
  branchId: z.uuid().optional(),
})

/** Una pregunta ya entendida: la que manda una opción de la respuesta o una respuesta fijada. */
const askQuery = reportQuery.extend({
  figure: z.string().min(1).max(60),
  group: z.enum(FIGURE_GROUPS),
  focus: z.string().max(60).nullable().optional(),
})

const askInput = z.union([
  reportQuery.extend({ text: z.string().trim().min(3, "Escribe tu pregunta").max(500, "La pregunta es demasiado larga") }).strict(),
  z.object({ query: askQuery }).strict(),
])

const pinInput = z.object({ figure: z.string().min(1).max(60), group: z.enum(FIGURE_GROUPS), focus: z.string().max(60).nullable().optional() }).strict()

const goalInput = z
  .object({ amount: z.number().int("La meta va en números enteros").positive("La meta tiene que ser mayor que cero").nullable() })
  .strict()

const digestInput = z.object({ enabled: z.boolean() }).strict()

const LIST_KEYS = z.enum([...REPORT_LISTS, ...PATIENT_REPORT_LISTS])

export interface ReportsDeps extends CrmDeps {
  llm: PlatformLlm
  decisions?: PlatformDecisions | undefined
}

/** Un archivo para descargar; un error del servicio va como siempre, en JSON. */
async function sendCsv(c: Context, make: () => Promise<CsvFile>) {
  try {
    const file = await make()
    return c.body(file.body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.filename}"`,
      "cache-control": "no-store",
    })
  } catch (error) {
    if (error instanceof ServiceError) return c.json(errorBody(c, error.code, error.message), error.status)
    throw error
  }
}

export function createReportsRoute(deps: ReportsDeps) {
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
  read("/agenda", getAgendaReport)
  read("/finance", getReportFinance)
  read("/finance/commissions", getReportCommissions)
  read("/finance/outlook", getReportOutlook)
  read("/finance/promotions", getReportPromotions)
  read("/patients", getReportPatients)
  read("/funnel", getReportFunnel)

  // Agente: lo pagado a odentIA va solo a quien ve Facturación (`seesBilling`, la misma regla de su ruta).
  app.get("/agent", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const billing = seesBilling(memberRole)
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
    const parsed = reportQuery.extend({ list: LIST_KEYS }).safeParse({ ...c.req.query(), list: c.req.param("list") })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { list, ...query } = parsed.data
    // Las listas de Pacientes son de personas (algunas aún no son pacientes): las arma su propio servicio.
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx): Promise<unknown> =>
        isPatientReportList(list) ? getPatientReportList(tx, orgId, { ...query, list }) : getReportList(tx, orgId, { ...query, list }),
      ),
    )
  })

  // --- Pregúntale a Argos (ADR 0070) ---------------------------------------------------

  /**
   * Una pregunta con palabras pasa por el modelo de decisión (solo el texto,
   * nada de la clínica) y cuenta para el tope diario; una pregunta ya
   * entendida (una opción que se tocó) no. Si el modelo no responde se dice y
   * las cifras siguen a la vista.
   */
  app.post("/ask", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    const parsed = askInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const options = { billing: seesBilling(memberRole), can: (permission: string) => canAccess(memberRole, permission) }
    return runService(c, 200, async () => {
      const body = parsed.data
      const screenOf = "text" in body ? { period: body.period, branchId: body.branchId } : undefined
      const ready = await withOrgContext(deps.db, orgId, (tx) => prepareReportQuestion(tx, orgId, new Date(), screenOf))
      if (!ready.enabled) return { kind: "apagado" as const, message: REPORT_ASK_WORDS.apagado }
      if ("query" in body) return withOrgContext(deps.db, orgId, (tx) => answerReportQuery(tx, orgId, userId, body.query, options))
      if (ready.roomLeft <= 0) return { kind: "tope" as const, message: REPORT_ASK_WORDS.tope }
      let understood: ReportInterpretationResult
      try {
        understood = await meterAiUse(deps.db, orgId, "reportes", async () => {
          const model = await createAdminDecisionModel(deps.db, { secretsKey: deps.secretsKey, platform: deps.llm, decisions: deps.decisions }, orgId)
          // Con el modelo de demostración responde el doble determinista de los servicios.
          return interpretReportQuestion(body.text, model ? asAdminDecider(model) : keywordReportDecider(), {
            timezone: ready.timezone,
            now: new Date(),
            branches: ready.branches,
            billing: options.billing,
          })
        })
      } catch {
        return withOrgContext(deps.db, orgId, (tx) => recordReportQuestionFailure(tx, orgId, userId))
      }
      const screen = { period: body.period, branchId: body.branchId }
      return withOrgContext(deps.db, orgId, (tx) => resolveReportQuestion(tx, orgId, userId, body.text, understood, screen, options))
    })
  })

  app.get("/pins", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const options = { billing: seesBilling(memberRole), can: (permission: string) => canAccess(memberRole, permission) }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listReportPins(tx, orgId, parsed.data, options)))
  })

  app.post("/pins", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    const parsed = pinInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => pinReportAnswer(tx, orgId, userId, parsed.data, seesBilling(memberRole))))
  })

  app.delete("/pins/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    const id = z.uuid().safeParse(c.req.param("id"))
    if (!id.success) return validationError(c, id.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => unpinReportAnswer(tx, orgId, id.data))
      return { removed: true }
    })
  })

  // --- Metas, resumen del lunes y descargas (ADR 0071) ----------------------------------

  // Las metas son de quien dirige la clínica: la misma persona que configura Reportes.
  app.put("/goals/:metric", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "reports.write")) return c.json(errorBody(c, "FORBIDDEN", "No puedes cambiar las metas"), 403)
    const metric = z.enum(REPORT_GOAL_METRICS).safeParse(c.req.param("metric"))
    if (!metric.success) return validationError(c, metric.error.issues)
    const parsed = goalInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => setReportGoal(tx, orgId, userId, { metric: metric.data, amount: parsed.data.amount })))
  })

  app.get("/digest", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getReportDigest(tx, orgId, userId)))
  })

  app.put("/digest", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = digestInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => setReportDigest(tx, orgId, userId, parsed.data.enabled)))
  })

  app.get("/download/list/:list", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = reportQuery.extend({ list: LIST_KEYS }).safeParse({ ...c.req.query(), list: c.req.param("list") })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const can = (permission: string): boolean => canAccess(memberRole, permission)
    return sendCsv(c, () => withOrgContext(deps.db, orgId, (tx) => reportListCsv(tx, orgId, parsed.data, can)))
  })

  app.get("/download/professionals", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return sendCsv(c, () => withOrgContext(deps.db, orgId, (tx) => reportProfessionalsCsv(tx, orgId, parsed.data)))
  })

  app.get("/download/commissions", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return sendCsv(c, () => withOrgContext(deps.db, orgId, (tx) => reportCommissionsCsv(tx, orgId, parsed.data)))
  })

  app.get("/download/answer", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = askQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const options = { billing: seesBilling(memberRole), can: (permission: string) => canAccess(memberRole, permission) }
    return sendCsv(c, () => withOrgContext(deps.db, orgId, (tx) => reportAnswerCsv(tx, orgId, parsed.data, options)))
  })

  return app
}
