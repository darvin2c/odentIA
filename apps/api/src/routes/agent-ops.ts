import {
  isProviderConfigError,
  meterAiUse,
  type PlatformDecisions,
  type PlatformLlm,
  simulateAgentTurn,
  TOOL_ACTION_LABEL,
} from "@odentia/agent"
import { buildWebchatInbound } from "@odentia/channels"
import { type Db, sendInboundMessage, withOrgContext } from "@odentia/db"
import { inboundEvent } from "@odentia/db/schema/crm"
import {
  assertAgentTestBudget,
  confirmProposalByContact,
  confirmProposalByPhone,
  createHandoff,
  operationBodySchema,
  createProposal,
  deleteProbar,
  deleteWebchatTest,
  executeProposal,
  getProbar,
  openProbar,
  type ProbarState,
  probarSession,
  getAgentPanelSummary,
  getAgentRunStats,
  getProposal,
  listAgentActivity,
  listAgentDecisions,
  listAgentRuns,
  listAnswerTraces,
  listAwaitingAnswer,
  listHandoffs,
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
import { modelProblemResponse } from "../lib/agent-model.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

export interface AgentOpsDeps extends CrmDeps {
  /** Proveedor de la plataforma; la configuración de la organización prevalece. */
  llm: PlatformLlm
  /** Rol owner: el caso «Modelo sin responder» en Soporte de odentIA. */
  ownerDb?: Db
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

// Los campos de una derivación se declaran una vez, para la pantalla y para el agente.
const handoffInput = operationBodySchema("derivacion.crear")

const decisionsQuery = z.object({
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const probarMessageInput = z.object({
  text: z.string().trim().min(1, "Escribe el mensaje del paciente.").max(2000, "Escribe como mucho 2000 caracteres."),
  /** Lo genera la pantalla: reenviar el mismo mensaje no lo duplica. */
  clientMessageId: z.string().uuid(),
})

const simulateInput = z.object({
  conversationId: z.string({ error: "Elige una conversación." }).uuid("Elige una conversación de la lista."),
  text: z.string().min(1, "Escribe el mensaje del paciente.").max(4000, "Escribe como mucho 4000 caracteres."),
})

  const app = new Hono()

  function forbidden(c: Context, _perm?: string) {
    return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
  }

  /**
   * Puerta operativa de propuestas: lectura con `agent.read` o `agent.decide`;
   * registrar la confirmación o ejecutar con `agent.decide` más el permiso del dominio
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

  /**
   * Agente › «Esperan su sí»: las citas que el agente propuso y esperan la
   * respuesta de la persona. Lo ven los mismos roles que antes veían Pendientes.
   */
  app.get("/awaiting", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"])) return forbidden(c, "agent.decide")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAwaitingAnswer(tx, orgId, { limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined }),
      ),
    )
  })

  /** «Confirmó por teléfono»: el mismo permiso que registrar una confirmación, en el dominio del acto. */
  app.post("/proposals/:id/phone-confirm", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.decide")) return forbidden(c, "agent.decide")
    if (!canAccess(memberRole, "conversations.write")) return forbidden(c, "conversations.write")
    const blocked = await actionGate(c, memberRole, orgId, c.req.param("id"))
    if (blocked) return blocked
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        confirmProposalByPhone(tx, orgId, userId, c.req.param("id"), { secretsKey: deps.secretsKey }),
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
          ...(c.req.query("order") === "urgencia" ? { order: "urgencia" as const } : {}),
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
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["agent.read", "agent.decide"]))
      return forbidden(c, "agent.decide")
    // El contador es de quien mira: lo que nadie tomó más lo suyo.
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgentPanelSummary(tx, orgId, userId)),
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
   * «Probar» (ADR 0094): una conversación real con Sofi por el recorrido del
   * chat web, con una persona de prueba. Cada turno sale de la misma corrida
   * que una conversación real; lo que crea queda marcado «Prueba».
   */
  const probarView = (state: ProbarState) => ({
    ...state,
    turns: state.turns.map((turn) => ({
      ...turn,
      did: turn.toolsUsed.map((tool) => TOOL_ACTION_LABEL[tool]).filter((label): label is string => Boolean(label)),
    })),
  })

  app.get("/probar", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    return runService(c, 200, async () =>
      probarView(await withOrgContext(deps.db, orgId, (tx) => getProbar(tx, orgId, userId, { secretsKey: deps.secretsKey }))),
    )
  })

  /** «Empezar de nuevo»: borra la prueba anterior con lo que creó y abre otra. */
  app.post("/probar", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    return runService(c, 201, async () =>
      probarView(
        await withOrgContext(deps.db, orgId, async (tx) => {
          await openProbar(tx, orgId, userId, { secretsKey: deps.secretsKey })
          return getProbar(tx, orgId, userId, { secretsKey: deps.secretsKey })
        }),
      ),
    )
  })

  app.delete("/probar", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async (tx) => ({ deleted: await deleteProbar(tx, orgId, userId) })))
  })

  /** «Borrar esta prueba» desde la cita de prueba de la Agenda: la de quien sea, con todo lo que creó. */
  app.post("/probar/delete", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = z.object({ conversationId: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({ deleted: await deleteWebchatTest(tx, orgId, { conversationId: parsed.data.conversationId }) })),
    )
  })

  /**
   * Escribir como paciente: el mensaje entra como uno del chat web (la misma
   * ingesta y la misma cola); el worker corre a Sofi como en cualquier canal.
   */
  app.post("/probar/messages", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = probarMessageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const ownerDb = deps.ownerDb
    if (!ownerDb) return c.json(errorBody(c, "UNAVAILABLE", "Probar no está disponible"), 503)
    return runService(c, 201, async () => {
      const session = await withOrgContext(deps.db, orgId, async (tx) => {
        await assertAgentTestBudget(tx, orgId)
        const found = (await probarSession(tx, orgId, userId)) ?? (await openProbar(tx, orgId, userId, { secretsKey: deps.secretsKey }))
        return { sessionId: found.sessionId, connectionId: found.connectionId }
      })
      const event = buildWebchatInbound(session.sessionId, { text: parsed.data.text, clientMessageId: parsed.data.clientMessageId })
      await ownerDb.transaction(async (tx) => {
        const inserted = await tx
          .insert(inboundEvent)
          .values({ provider: "web_chat", externalEventId: event.externalEventId })
          .onConflictDoNothing()
          .returning({ id: inboundEvent.id })
        if (inserted.length > 0) await sendInboundMessage(tx, { orgId, connectionId: session.connectionId, event })
      })
      return { queued: true }
    })
  })

  app.post("/simulate", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return forbidden(c, "agent.write")
    const parsed = simulateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return await runService(c, 200, async () => {
        await withOrgContext(deps.db, orgId, (tx) => assertAgentTestBudget(tx, orgId))
        return meterAiUse(
          deps.db,
          orgId,
          "simulacion",
          () =>
            simulateAgentTurn(
              deps.db,
              { secretsKey: deps.secretsKey, platform: deps.llm },
              { orgId, conversationId: parsed.data.conversationId, text: parsed.data.text },
            ),
          parsed.data.conversationId,
        )
      })
    } catch (error) {
      // Proveedor inutilizable (configuración, credencial, cuota): es un
      // estado de la organización, no un error del servidor, y nunca se
      // reenvía el cuerpo crudo del proveedor.
      if (isProviderConfigError(error)) return modelProblemResponse(c, deps, orgId, error, "agente")
      throw error
    }
  })

  return app
}
