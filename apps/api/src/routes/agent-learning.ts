import { createRuleConflictModel, isProviderConfigError, meterAiUse, type PlatformDecisions, type PlatformLlm, previewLesson } from "@odentia/agent"
import { type Db, withOrgContext } from "@odentia/db"
import {
  addAgentGuidance,
  approveLesson,
  editAgentGuidance,
  findRuleConflict,
  listAgentGuidance,
  removeAgentGuidance,
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
import { modelProblemResponse } from "../lib/agent-model.js"
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

const guidanceInput = z.object({ body: z.string().trim().min(1).max(2000) })
const approveInput = z.object({ replaceId: z.string().uuid().optional() })

export interface AgentLearningDeps extends CrmDeps {
  llm: PlatformLlm
  /** Credenciales del modelo de decisión: con él se detecta si una regla contradice otra. */
  decisions?: PlatformDecisions
  /** Rol owner: el caso «Modelo sin responder» en Soporte de odentIA. */
  ownerDb?: Db
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

  /**
   * «Lo que el agente debe saber» (decisión 24): una sola lista con lo que
   * escribió la clínica y lo que aprendió. La lee quien supervisa el agente y
   * la cambia quien lo administra.
   */
  app.get("/guidance", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c)
    const source = c.req.query("source")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listAgentGuidance(tx, orgId, source ? { source } : {})))
  })

  app.post("/guidance", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    const parsed = guidanceInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => addAgentGuidance(tx, orgId, userId, parsed.data.body)))
  })

  app.patch("/guidance/:id", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    const parsed = guidanceInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => editAgentGuidance(tx, orgId, userId, c.req.param("id"), parsed.data.body)),
    )
  })

  app.delete("/guidance/:id", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => removeAgentGuidance(tx, orgId, userId, c.req.param("id")))
      return { ok: true }
    })
  })

  /**
   * Antes de aprobar una regla: ¿contradice otra? Con el modelo de decisión de
   * la clínica si lo configuró; si no, con la comparación simple. Solo lee.
   */
  app.get("/lessons/:id/conflict", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    return runService(c, 200, async () => {
      const model = await createRuleConflictModel(deps.db, { secretsKey: deps.secretsKey, platform: deps.llm, ...(deps.decisions ? { decisions: deps.decisions } : {}) }, orgId).catch(() => null)
      return withOrgContext(deps.db, orgId, (tx) => findRuleConflict(tx, orgId, c.req.param("id"), model))
    })
  })

  // «Reemplazar»: aprobar la regla nueva retira la que contradecía, en el mismo paso.
  app.post("/lessons/:id/approve", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    const parsed = approveInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        approveLesson(tx, orgId, userId, c.req.param("id"), parsed.data.replaceId ? { replaceId: parsed.data.replaceId } : {}),
      ),
    )
  })

  for (const [path, action] of [
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
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c)
    try {
      return await runService(c, 200, async () => {
        await withOrgContext(deps.db, orgId, (tx) => assertAgentTestBudget(tx, orgId))
        return meterAiUse(deps.db, orgId, "vista_previa", () =>
          previewLesson(
            deps.db,
            { secretsKey: deps.secretsKey, platform: deps.llm, storage: deps.storage },
            { orgId, userId, lessonId: c.req.param("id") },
          ),
        )
      })
    } catch (error) {
      if (isProviderConfigError(error)) return modelProblemResponse(c, deps, orgId, error, "agente")
      throw error
    }
  })

  return app
}
