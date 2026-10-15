import { describeProviderProblem, isProviderConfigError, meterAiUse, type PlatformLlm, previewLesson } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import {
  approveLesson,
  correctAnswer,
  discardLesson,
  getLearningOverview,
  getLesson,
  lessonImpact,
  listTestCases,
  markAnswerOk,
  markReviewOk,
  restoreLesson,
  saveTestCase,
  updateLesson,
  withdrawLesson,
  assertAgentTestBudget,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const correctionInput = z
  .object({
    reviewItemId: z.string().uuid().optional(),
    traceId: z.string().uuid().optional(),
    failure: z.enum(["dato_equivocado", "falto_dato", "tono", "no_debio_responder", "otra_cosa"]),
    correctedReply: z.string().max(2000).optional(),
  })
  .refine((input) => Boolean(input.reviewItemId) !== Boolean(input.traceId), "Indica una sola respuesta que corregir")

const lessonPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(2000).optional(),
  kind: z.enum(["respuesta_oficial", "regla", "ejemplo"]).optional(),
  knowledgeEntryId: z.null().optional(),
})

const caseInput = z.object({ question: z.string().trim().min(1).max(2000), expected: z.string().trim().min(1).max(4000) })

const withdrawInput = z.object({ withdrawCase: z.boolean().optional() })

export interface AgentLearningDeps extends CrmDeps {
  llm: PlatformLlm
}

/**
 * Aprender: lo dudoso que revisa una persona y lo que el agente propone
 * aprender. Leer pide supervisar el agente; revisar y corregir, decidir por él;
 * aprobar, retirar o restaurar una lección, administrarlo.
 */
export function createAgentLearningRoute(deps: AgentLearningDeps) {
  const app = new Hono()
  const forbidden = (c: Context) => c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getLearningOverview(tx, orgId)))
  })

  app.get("/cases", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listTestCases(tx, orgId)))
  })

  // Guardar una conversación de «Probar» como caso: la da por buena quien administra el agente.
  app.post("/cases", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    const parsed = caseInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => saveTestCase(tx, orgId, userId, parsed.data)))
  })

  app.post("/review/:id/ok", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.decide", "agent.write"])) return forbidden(c)
    const parsed = z.object({ asExample: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => ({
      // Con `asExample`, la respuesta queda propuesta como ejemplo para preguntas parecidas.
      lesson: await withOrgContext(deps.db, orgId, (tx) => markReviewOk(tx, orgId, userId, c.req.param("id"), parsed.data)),
    }))
  })

  // Marcar una respuesta desde la Bandeja (bien o por corregir) es de quien
  // atiende conversaciones; lo que se aprende lo aprueba quien administra.
  app.post("/answers/:traceId/ok", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.write", "agent.decide", "agent.write"])) return forbidden(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => markAnswerOk(tx, orgId, userId, c.req.param("traceId")))
      return { ok: true }
    })
  })

  app.post("/corrections", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.write", "agent.decide", "agent.write"])) return forbidden(c)
    const parsed = correctionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => correctAnswer(tx, orgId, userId, parsed.data)))
  })

  app.get("/lessons/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const lesson = await getLesson(tx, orgId, c.req.param("id"))
        return { lesson, impact: await lessonImpact(tx, orgId, lesson) }
      }),
    )
  })

  app.patch("/lessons/:id", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    const parsed = lessonPatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateLesson(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })

  for (const [path, action] of [
    ["approve", approveLesson],
    ["discard", discardLesson],
    ["restore", restoreLesson],
  ] as const) {
    app.post(`/lessons/:id/${path}`, async (c) => {
      const { orgId, memberRole, userId } = orgContextOf(c)
      if (!canAccess(memberRole, "agent.write")) return forbidden(c)
      return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => action(tx, orgId, userId, c.req.param("id"))))
    })
  }

  app.post("/lessons/:id/withdraw", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    const parsed = withdrawInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => withdrawLesson(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })

  /**
   * Responde los casos que tocan la lección, hoy y con el cambio. Llama al
   * modelo (dos conversaciones por caso): solo a pedido, nunca al listar.
   */
  app.post("/lessons/:id/preview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    try {
      return await runService(c, 200, async () => {
        await withOrgContext(deps.db, orgId, (tx) => assertAgentTestBudget(tx, orgId))
        return meterAiUse(deps.db, orgId, "vista_previa", () =>
          previewLesson(deps.db, { secretsKey: deps.secretsKey, platform: deps.llm }, { orgId, lessonId: c.req.param("id") }),
        )
      })
    } catch (error) {
      if (isProviderConfigError(error)) {
        const problem = describeProviderProblem(error)
        return c.json(errorBody(c, "LLM_CONFIG", `El agente no puede usar el modelo (${problem.detail})`), 409)
      }
      throw error
    }
  })

  return app
}
