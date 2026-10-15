import {
  describeProviderProblem,
  isProviderConfigError,
  type PlatformDecisions,
  type PlatformLlm,
  simulateAgentSandbox,
  simulateAgentTurn,
} from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import {
  confirmProposalByContact,
  createHandoff,
  operationBodySchema,
  createProposal,
  decideProposal,
  executeProposal,
  getAgentPanelSummary,
  getAgentRunStats,
  getProposal,
  listAgentActivity,
  listAgentDecisions,
  listAgentRuns,
  listAnswerTraces,
  listHandoffs,
  noteSandboxTurn,
  claimHandoff,
  getCaseBrief,
  listProposals,
  requiredPermissionForAction,
  type SearchEmbedder,
  ServiceError,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

export interface AgentOpsDeps extends CrmDeps {
  /** Proveedor de la plataforma; la configuración de la organización prevalece. */
  llm: PlatformLlm
  /** Credenciales del modelo de decisión: «Probar» elige el camino igual que una conversación real. */
  decisions?: PlatformDecisions
  embedder?: SearchEmbedder
}

export function createAgentOpsRoute(deps: AgentOpsDeps) {

const proposalInput = z.object({
  conversationId: z.string().uuid(),
  action: z.enum([
    "reservar_cita",
    "reprogramar_cita",
    "cancelar_cita",
    "enviar_mensaje",
    "mover_oportunidad",
    "crear_oportunidad",
    "actualizar_seguimiento",
    "cerrar_oportunidad",
  ]),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(120),
})

const decideInput = z.object({
  decision: z.enum(["aprobada", "rechazada"]),
  reason: z.string().max(2000).optional(),
})

// Los campos de una derivación se declaran una vez, para la pantalla y para el agente.
const handoffInput = operationBodySchema("derivacion.crear")

const decisionsQuery = z.object({
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const simulateInput = z.object({
  conversationId: z.string().uuid(),
  text: z.string().min(1).max(4000),
})

const sandboxProposal = z.object({
  id: z.string().uuid(),
  action: z.string().max(40),
  label: z.string().max(80),
  summary: z.string().max(300),
  status: z.string().max(20),
  decider: z.enum(["contact", "team"]),
  detail: z.string().max(300).nullable(),
  at: z.string().max(40),
  expiresAt: z.string().max(40).nullable(),
})

/**
 * Conversación de prueba: el historial y el estado los trae quien prueba y
 * solo alimentan esa prueba; por eso van acotados, no porque se confíe en ellos.
 */
const sandboxInput = z.object({
  message: z.string().min(1).max(2000),
  transcript: z
    .array(z.object({ role: z.enum(["contact", "agent"]), text: z.string().max(4000) }))
    .max(40)
    .default([]),
  state: z
    .object({
      pending: z.array(sandboxProposal).max(5),
      recent: z.array(sandboxProposal).max(5),
      notes: z.array(z.object({ text: z.string().max(300), at: z.string().max(40) })).max(12),
      lookups: z.array(z.object({ tool: z.string().max(40), text: z.string().max(2100), at: z.string().max(40) })).max(5),
    })
    .optional(),
})

  const app = new Hono()

  function forbidden(c: Context, _perm?: string) {
    return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
  }

  /**
   * Puerta operativa de propuestas: lectura con `agent.read` o `agent.decide`;
   * decidir/confirmar/ejecutar con `agent.decide` más el permiso del dominio
   * del acto (ver `actionGate`). La administración del agente sigue pidiendo
   * `agent.write` en sus rutas propias.
   */
  async function actionGate(c: Context, memberRole: string, orgId: string, id: string): Promise<Response | null> {
    const proposal = await withOrgContext(deps.db, orgId, (tx) => getProposal(tx, orgId, id)).catch((error: unknown) => {
      if (error instanceof ServiceError && error.code === "NOT_FOUND" && error.status === 404) return null
      throw error
    })
    if (!proposal) return c.json(errorBody(c, "NOT_FOUND", "Propuesta no encontrada"), 404)
    const needed = requiredPermissionForAction(proposal.action)
    if (!canAccess(memberRole, needed)) {
      return c.json(errorBody(c, "FORBIDDEN", `Esta propuesta exige permiso ${needed}`), 403)
    }
    return null
  }


  app.get("/proposals", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"])) return forbidden(c, "agent.decide")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listProposals(tx, orgId, {
          status: c.req.query("status"),
          conversationId: c.req.query("conversationId"),
          contactId: c.req.query("contactId"),
          patientId: c.req.query("patientId"),
          limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        }),
      ),
    )
  })

  app.post("/proposals", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = proposalInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const needed = requiredPermissionForAction(parsed.data.action)
    if (!canAccess(memberRole, needed)) {
      return c.json(errorBody(c, "FORBIDDEN", `Esta propuesta exige permiso ${needed}`), 403)
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createProposal(tx, orgId, {
          conversationId: parsed.data.conversationId,
          action: parsed.data.action,
          payload: parsed.data.payload,
          reason: parsed.data.reason,
          idempotencyKey: parsed.data.idempotencyKey,
          proposedBy: "user",
          actorUserId: userId,
          secretsKey: deps.secretsKey,
        }),
      ),
    )
  })

  app.get("/proposals/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"])) return forbidden(c, "agent.decide")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getProposal(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/proposals/:id/decision", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.decide")) return forbidden(c, "agent.decide")
    const parsed = decideInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const blocked = await actionGate(c, memberRole, orgId, c.req.param("id"))
    if (blocked) return blocked
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        decideProposal(tx, orgId, userId, c.req.param("id"), parsed.data, { secretsKey: deps.secretsKey }),
      ),
    )
  })

  app.post("/proposals/:id/execute", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.decide")) return forbidden(c, "agent.decide")
    const blocked = await actionGate(c, memberRole, orgId, c.req.param("id"))
    if (blocked) return blocked
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        executeProposal(tx, orgId, userId, c.req.param("id"), { secretsKey: deps.secretsKey }),
      ),
    )
  })

  app.post("/proposals/:id/confirm", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    // Registrar la confirmación explícita del interlocutor: exige decidir en
    // el dominio del acto y operar la conversación; jamás inventa consentimiento.
    if (!canAccess(memberRole, "agent.decide")) return forbidden(c, "agent.decide")
    if (!canAccess(memberRole, "conversations.write")) return forbidden(c, "conversations.write")
    const parsed = z.object({ contactId: z.string().uuid() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const blocked = await actionGate(c, memberRole, orgId, c.req.param("id"))
    if (blocked) return blocked
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        confirmProposalByContact(tx, orgId, parsed.data.contactId, c.req.param("id"), {
          staffUserId: userId,
          secretsKey: deps.secretsKey,
        }),
      ),
    )
  })

  app.get("/handoffs", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"])) return forbidden(c, "agent.decide")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listHandoffs(tx, orgId, {
          conversationId: c.req.query("conversationId"),
          limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
          open: c.req.query("open") === "1" || c.req.query("open") === "true",
        }),
      ),
    )
  })

  app.post("/handoffs", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = handoffInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createHandoff(tx, orgId, userId, { ...parsed.data, createdBy: "user" }),
      ),
    )
  })

  app.post("/handoffs/:id/claim", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "tasks.write")) return forbidden(c, "tasks.write")
    const id = c.req.param("id")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => claimHandoff(tx, orgId, userId, id)),
    )
  })

  app.get("/runs", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c, "agent.read")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAgentRuns(tx, orgId, {
          conversationId: c.req.query("conversationId"),
          status: c.req.query("status"),
          limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        }),
      ),
    )
  })

  // Resumen y actividad legible del panel: quien decide (recepción) los lee
  // sin acceder a configuración ni al libro técnico.
  app.get("/panel", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"]))
      return forbidden(c, "agent.decide")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgentPanelSummary(tx, orgId)),
    )
  })

  app.get("/activity", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"]))
      return forbidden(c, "agent.decide")
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listAgentActivity(tx, orgId, parsed.data)),
    )
  })

  app.get("/decisions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c, "agent.read")
    const parsed = decisionsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listAgentDecisions(tx, orgId, parsed.data)),
    )
  })

  app.get("/runs/stats", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c, "agent.read")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getAgentRunStats(tx, orgId, { from: c.req.query("from"), to: c.req.query("to") }),
      ),
    )
  })

  /**
   * En qué se basó cada respuesta del agente en un hilo. Lo lee quien puede
   * ver la conversación: la traza nombra fuentes y datos comprobados, nunca
   * contenido que el hilo no muestre ya.
   */
  app.get("/answer-traces", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.read", "agent.read"])) return forbidden(c, "conversations.read")
    const parsed = z
      .object({ conversationId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAnswerTraces(tx, orgId, parsed.data.conversationId, { limit: parsed.data.limit }),
      ),
    )
  })

  /**
   * Resumen del caso para quien lo toma: lo que la persona escribió, lo que ya
   * se sabe y lo que hizo el agente. Lo que se recuerda de la persona solo
   * viaja a quien puede ver sus contactos.
   */
  app.get("/case/brief", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.read", "agent.read"])) return forbidden(c, "conversations.read")
    const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getCaseBrief(tx, orgId, parsed.data.conversationId, { includePerson: canAccessAny(memberRole, ["conversations.read", "crm.read"]) }),
      ),
    )
  })

  /**
   * «Probar»: un turno de una conversación de prueba, sin hilo ni persona
   * real. No envía ni escribe; solo cuenta que la clínica probó a su agente.
   */
  app.post("/sandbox", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = sandboxInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return await runService(c, 200, async () => {
        const result = await simulateAgentSandbox(
          deps.db,
          { secretsKey: deps.secretsKey, platform: deps.llm, decisions: deps.decisions, embedder: deps.embedder },
          { orgId, ...parsed.data },
        )
        await withOrgContext(deps.db, orgId, (tx) => noteSandboxTurn(tx, orgId))
        return result
      })
    } catch (error) {
      if (isProviderConfigError(error)) {
        const problem = describeProviderProblem(error)
        return c.json(errorBody(c, "LLM_CONFIG", `El agente no puede usar el modelo (${problem.detail})`), 409)
      }
      throw error
    }
  })

  app.post("/simulate", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = simulateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return await runService(c, 200, () =>
        simulateAgentTurn(
          deps.db,
          { secretsKey: deps.secretsKey, platform: deps.llm },
          { orgId, conversationId: parsed.data.conversationId, text: parsed.data.text },
        ),
      )
    } catch (error) {
      // Proveedor inutilizable (configuración, credencial, cuota): es un
      // estado de la organización, no un error del servidor, y nunca se
      // reenvía el cuerpo crudo del proveedor.
      if (isProviderConfigError(error)) {
        const problem = describeProviderProblem(error)
        return c.json(errorBody(c, "LLM_CONFIG", `El agente no puede usar el modelo (${problem.detail})`), 409)
      }
      throw error
    }
  })

  return app
}
