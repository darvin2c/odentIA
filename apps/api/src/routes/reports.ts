/**
 * Reportes: las cuatro preguntas de quien dirige la clínica y la lista detrás
 * de cada cifra. Montaje del padre: `guarded.route("/reports", createReportsRoute(crmDeps))`.
 *
 * Todo pide `reports.read`: ni caja ni el profesional lo ven. El periodo es una
 * opción cerrada (meses completos) o un rango de días; la sede es opcional.
 * Además: preguntarle a Argos sobre las vistas del negocio (ADR 0073), las
 * respuestas fijadas, las metas, el resumen del lunes de cada persona y
 * «Descargar» en CSV (ADR 0071).
 */
import { askArgos, meterAiUse, type PlatformDecisions, type PlatformLlm, routeArgos, routeByWords, showArgosAnswer } from "@odentia/agent"
import { seesBilling } from "@odentia/auth/permissions"
import { withOrgContext, type Db } from "@odentia/db"
import {
  ARGOS_DOWNLOAD_LIMIT,
  ArgosQueryError,
  argosAnswerCsv,
  getAdminSettings,
  getArgosAnswer,
  getOrgLocale,
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
  isPatientReportList,
  listArgosPins,
  listReportPins,
  PATIENT_REPORT_LISTS,
  pinArgosAnswer,
  REPORT_GOAL_METRICS,
  REPORT_LISTS,
  REPORT_PERIOD_PATTERN,
  reportCommissionsCsv,
  reportListCsv,
  reportProfessionalsCsv,
  type CsvFile,
  type ReportQuery,
  runArgosQuery,
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

/**
 * Una pregunta al Argos de las vistas (ADR 0073). Desde Reportes llevan su
 * periodo y su sede (D7); la anterior de la conversación va con su consulta
 * (D3) y solo se le muestra al modelo: no se corre ni se guarda.
 */
const argosInput = z
  .object({
    text: z.string().trim().min(3, "Escribe tu pregunta").max(500, "La pregunta es demasiado larga"),
    screen: reportQuery.optional(),
    previous: z.object({ text: z.string().trim().max(500), query: z.string().trim().max(4000) }).strict().nullable().optional(),
    /** La fila ya la decidió el buscador (D1): no se paga otra vez a Jev. */
    routed: z.boolean().optional(),
  })
  .strict()

const argosRouteInput = z.object({ text: z.string().trim().min(2).max(500) }).strict()

/** Una respuesta de Argos ya dada: la principal o una de las de seguir. */
const argosAnswerRef = z.object({ questionId: z.uuid(), option: z.number().int().min(0).max(2).nullable().optional() }).strict()

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

  // --- Argos sobre las vistas del negocio (ADR 0073) -----------------------------------

  /**
   * Jev decide la fila y ChatGPT 6 escribe la consulta; corre con la llave del
   * rol de quien pregunta. Todo lo que se paga al proveedor queda medido con el
   * origen `reportes`.
   */
  app.post("/argos", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    const parsed = argosInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    return runService(c, 200, () =>
      meterAiUse(deps.db, orgId, "reportes", () =>
        askArgos(
          deps.db,
          { platform: deps.llm, decisions: deps.decisions, secretsKey: deps.secretsKey },
          {
            orgId,
            userId,
            memberRole,
            text: body.text,
            ...(body.screen ? { screen: body.screen } : {}),
            previous: body.previous ?? null,
            routed: body.routed === true,
          },
        ),
      ),
    )
  })

  /** La fila del buscador (D1): Jev decide con solo el texto si es una pregunta de los datos, de la Ayuda o algo para buscar. */
  app.post("/argos/route", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = argosRouteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const text = parsed.data.text
    const argosDeps = { platform: deps.llm, decisions: deps.decisions, secretsKey: deps.secretsKey }
    return runService(c, 200, async () => {
      // Un teléfono, un documento o un número de historia se buscan: no viajan a ningún modelo. Con Argos apagado
      // tampoco: las palabras dicen si va primero la Ayuda; lo demás, los resultados.
      if (/^[\d\s+().-]+$/.test(text)) return { route: "buscar" as const }
      const { enabled } = await withOrgContext(deps.db, orgId, (tx) => getAdminSettings(tx, orgId))
      if (!enabled) return { route: routeByWords(text) === "ayuda" ? ("ayuda" as const) : ("buscar" as const) }
      return { route: await meterAiUse(deps.db, orgId, "reportes", () => routeArgos(deps.db, argosDeps, orgId, text)) }
    })
  })

  /** Fijar en el Resumen (D5): se guarda la consulta y sus frases; el Resumen la vuelve a correr cada vez. */
  app.post("/argos/pins", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = argosAnswerRef.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, async (tx) => pinArgosAnswer(tx, orgId, userId, await getArgosAnswer(tx, orgId, userId, parsed.data.questionId, parsed.data.option ?? null))),
    )
  })

  /** Descargar (D5): la misma consulta, corrida otra vez con la llave de quien descarga. */
  app.get("/argos/:questionId/csv", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    const raw = c.req.query("option")
    const parsed = argosAnswerRef.safeParse({ questionId: c.req.param("questionId"), option: raw === undefined || raw === "" ? null : Number(raw) })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return sendCsv(c, async () => {
      const { answer, zone } = await withOrgContext(deps.db, orgId, async (tx) => ({
        answer: await getArgosAnswer(tx, orgId, userId, parsed.data.questionId, parsed.data.option ?? null),
        zone: await getOrgLocale(tx, orgId),
      }))
      // El mismo tope que los demás CSV de Reportes, no el de la respuesta en pantalla.
      const result = await runArgosQuery(deps.db, { orgId, memberRole, query: answer.sql, rowLimit: ARGOS_DOWNLOAD_LIMIT }).catch((error: unknown) => {
        throw error instanceof ArgosQueryError ? new ServiceError("ARGOS_QUERY", 409, error.message) : error
      })
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
      return argosAnswerCsv(answer.titulo, day, result, zone.timezone)
    })
  })

  app.get("/pins", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = reportQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const options = { billing: seesBilling(memberRole), can: (permission: string) => canAccess(memberRole, permission) }
    return runService(c, 200, async () => {
      const { figures, saved, zone } = await withOrgContext(deps.db, orgId, async (tx) => ({
        figures: await listReportPins(tx, orgId, parsed.data, options),
        saved: await listArgosPins(tx, orgId),
        zone: await getOrgLocale(tx, orgId),
      }))
      // Las del Argos de las vistas se vuelven a correr con la llave de quien mira, a la vez.
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      const argos = await Promise.all(
        saved.map(async (pin) => ({
          id: pin.id,
          pinnedBy: pin.pinnedBy,
          pinnedOn: day.format(new Date(pin.pinnedAt)),
          title: pin.answer.titulo,
          screen: pin.answer.pantalla,
          how: pin.answer.como,
          partial: pin.answer.parcial === true,
          missing: pin.answer.falta?.trim() || null,
          answer: await showArgosAnswer(deps.db, { orgId, memberRole, answer: pin.answer, zone }),
        })),
      )
      return { ...figures, argos }
    })
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

  return app
}
