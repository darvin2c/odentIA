/**
 * Reportes: las cuatro preguntas de quien dirige la clínica y la lista detrás
 * de cada cifra. Montaje del padre: `guarded.route("/reports", createReportsRoute(crmDeps))`.
 *
 * Todo pide `reports.read`: ni caja ni el profesional lo ven. El periodo es una
 * opción cerrada (meses completos) o un rango de días; la sede es opcional.
 * Además: preguntarle a Argos (ADR 0070), las respuestas fijadas, las metas,
 * el resumen del lunes de cada persona y «Descargar» en CSV (ADR 0071).
 */
import { asAdminDecider, askArgos, createAdminDecisionModel, meterAiUse, type PlatformDecisions, type PlatformLlm, routeArgos, showArgosAnswer } from "@odentia/agent"
import { seesBilling } from "@odentia/auth/permissions"
import { withOrgContext, type Db } from "@odentia/db"
import {
  answerReportQuery,
  ArgosQueryError,
  argosAnswerCsv,
  FIGURE_GROUPS,
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
  interpretReportQuestion,
  isPatientReportList,
  keywordReportDecider,
  listArgosPins,
  listReportPinKeys,
  listReportPins,
  PATIENT_REPORT_LISTS,
  pinArgosAnswer,
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
    const argosDeps = { platform: deps.llm, decisions: deps.decisions, secretsKey: deps.secretsKey }
    return runService(c, 200, async () => ({ route: await meterAiUse(deps.db, orgId, "reportes", () => routeArgos(deps.db, argosDeps, orgId, parsed.data.text)) }))
  })

  /** Fijar en el Resumen (D5): se guarda la consulta y sus frases; el Resumen la vuelve a correr cada vez. */
  app.post("/argos/pins", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = argosAnswerRef.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, async (tx) => pinArgosAnswer(tx, orgId, userId, await getArgosAnswer(tx, orgId, parsed.data.questionId, parsed.data.option ?? null))),
    )
  })

  /** Descargar (D5): la misma consulta, corrida otra vez con la llave de quien descarga. */
  app.get("/argos/:questionId/csv", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const raw = c.req.query("option")
    const parsed = argosAnswerRef.safeParse({ questionId: c.req.param("questionId"), option: raw === undefined || raw === "" ? null : Number(raw) })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return sendCsv(c, async () => {
      const { answer, zone } = await withOrgContext(deps.db, orgId, async (tx) => ({
        answer: await getArgosAnswer(tx, orgId, parsed.data.questionId, parsed.data.option ?? null),
        zone: await getOrgLocale(tx, orgId),
      }))
      const result = await runArgosQuery(deps.db, { orgId, memberRole, query: answer.sql }).catch((error: unknown) => {
        throw error instanceof ArgosQueryError ? new ServiceError("ARGOS_QUERY", 409, error.message) : error
      })
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
      return argosAnswerCsv(answer.titulo, day, result)
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
      // Las del Argos de las vistas se vuelven a correr con la llave de quien mira, una por una.
      const argos = []
      for (const pin of saved) {
        const shown = await showArgosAnswer(deps.db, { orgId, memberRole, answer: pin.answer, zone })
        argos.push({ id: pin.id, pinnedBy: pin.pinnedBy, pinnedAt: pin.pinnedAt, title: pin.answer.titulo, screen: pin.answer.pantalla, how: pin.answer.como, answer: shown })
      }
      return { ...figures, argos }
    })
  })

  // Solo qué está fijado, sin recalcular: lo lee cada respuesta del panel.
  app.get("/pins/keys", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listReportPinKeys(tx, orgId)))
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
