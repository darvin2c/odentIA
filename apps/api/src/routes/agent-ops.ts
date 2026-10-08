import { simulateAgentTurn } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import {
  confirmProposalByContact,
  createHandoff,
  createProposal,
  decideProposal,
  executeProposal,
  findFreeGaps,
  getAgentConfig,
  getAgentRunStats,
  getProposal,
  listAgentRuns,
  listHandoffs,
  claimHandoff,
  listProposals,
  requiredPermissionForAction,
  ServiceError,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

export interface AgentOpsDeps extends CrmDeps {
  /** Modelo del servidor (env LLM_MODEL del API); la config de la org prevalece. */
  defaultModelName?: string
  llmApiKey?: string
  llmBaseUrl?: string
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

const handoffInput = z.object({
  conversationId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  summary: z.string().min(1).max(2000),
  priority: z.enum(["alta", "media", "baja"]).default("media"),
  assigneeUserId: z.string().optional(),
})

const gapsInput = z.object({
  branchId: z.string().uuid(),
  from: z.string().min(1),
  to: z.string().min(1),
  durationMin: z.number().int().min(10).max(480),
  dentistUserId: z.string().optional(),
  chairId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
})

const simulateInput = z.object({
  conversationId: z.string().uuid(),
  text: z.string().min(1).max(4000),
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

  app.post("/availability/gaps", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c, "agent.read")
    const parsed = gapsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => findFreeGaps(tx, orgId, parsed.data)),
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

  app.get("/runs/stats", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return forbidden(c, "agent.read")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getAgentRunStats(tx, orgId, { from: c.req.query("from"), to: c.req.query("to") }),
      ),
    )
  })

  app.post("/simulate", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = simulateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      const model = await withOrgContext(deps.db, orgId, (tx) =>
        getAgentConfig(tx, orgId).then((cfg) => cfg.model ?? deps.defaultModelName ?? "fake"),
      )
      return simulateAgentTurn(
        deps.db,
        { secretsKey: deps.secretsKey, modelName: model, apiKey: deps.llmApiKey, baseUrl: deps.llmBaseUrl },
        { orgId, conversationId: parsed.data.conversationId, text: parsed.data.text, model },
      )
    })
  })

  return app
}
