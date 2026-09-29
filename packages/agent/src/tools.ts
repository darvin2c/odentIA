import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  confirmProposalByContact,
  createHandoff,
  createProposal,
  createTask,
  findFreeGaps,
  getAutonomyPolicy,
  getAgentPatientSummary,
  getClinicInfoSnapshot,
  listAgentContextCandidates,
  listOpportunities,
  moveOpportunity,
  requireContact,
  resolveAgentPatientContext,
  searchPublishedKnowledge,
  ServiceError,
  sendOutbound,
  sendTemplateOutbound,
  updateContact,
} from "@odentia/services"
import { z } from "zod"
export interface AgentToolCtx {
  db: Db
  orgId: string
  conversationId: string
  contactId: string
  secretsKey: Buffer
  /** La herramienta de handoff lo marca; el grafo termina el turno. */
  handedOff: boolean
  /** Simulación: las herramientas no escriben nada, solo describen. */
  dryRun: boolean
  /** Mensaje hipotético solo para simulación (no se persiste). */
  draftText?: string
  /** Nombres de herramientas usadas en la corrida (supervisión). */
  toolsUsed: string[]
  /** Tokens acumulados solo si el proveedor los reporta. */
  usage: { inputTokens: number; outputTokens: number; reported: boolean }
}

/**
 * Derivación a humano: registro estructurado (resumen, motivo, prioridad,
 * tarea), apaga el agente y avisa al equipo. Misma vía para keyword, tool y
 * maxTurns.
 */
export async function performHandoff(ctx: AgentToolCtx, reason: string, summary?: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.handedOff = true
    return
  }
  await withOrgContext(ctx.db, ctx.orgId, async (tx) => {
    await createHandoff(tx, ctx.orgId, null, {
      conversationId: ctx.conversationId,
      reason,
      summary: summary?.trim() ? summary : reason,
      priority: "media",
      createdBy: "agent",
    })
  })
  ctx.handedOff = true
}

/**
 * Tools del agente. NUNCA SQL ni fetch arbitrario: solo servicios dentro
 * del contexto RLS de la org (invariante). En simulación (dryRun) las
 * mutaciones devuelven vista previa sin escribir.
 */
export function makeAgentTools(ctx: AgentToolCtx) {
  const inOrg = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withOrgContext(ctx.db, ctx.orgId, fn)

  const sendReply = tool(
    async ({ text }: { text: string }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se enviaría al paciente: ${text}`
      const mode = await inOrg((tx) => getAutonomyPolicy(tx, ctx.orgId).then((p) => p.enviar_mensaje))
      if (mode !== "directo") {
        return `Bloqueado por la política de la clínica (enviar_mensaje=${mode}): no envíes texto, deriva a humano para que el equipo responda.`
      }
      try {
        const sent = await inOrg((tx) =>
          sendOutbound(tx, ctx.orgId, {
            conversationId: ctx.conversationId,
            senderKind: "agent",
            content: { type: "text", text },
          }),
        )
        return `Respuesta enviada (id ${sent.id}).`
      } catch (e) {
        if (e instanceof ServiceError && e.code === "WINDOW_CLOSED") {
          return "outside_window: fuera de la ventana de 24h de WhatsApp. Usa send_template con una plantilla autorizada o deriva a humano."
        }
        throw e
      }
    },
    {
      name: "send_reply",
      description:
        "Envía un texto al paciente. Si devuelve outside_window, usa send_template o deriva.",
      schema: z.object({ text: z.string().min(1).max(4000) }),
    },
  )

  const sendTemplate = tool(
    async ({ name, language, params }: { name: string; language: string; params: string[] }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se enviaría plantilla ${name} (${language}).`
      const mode = await inOrg((tx) => getAutonomyPolicy(tx, ctx.orgId).then((p) => p.enviar_mensaje))
      if (mode !== "directo") {
        return `Bloqueado por la política de la clínica (enviar_mensaje=${mode}): deriva a humano.`
      }
      const sent = await inOrg((tx) =>
        sendTemplateOutbound(tx, ctx.orgId, ctx.secretsKey, {
          conversationId: ctx.conversationId,
          senderKind: "agent",
          name,
          language,
          params,
        }),
      )
      return `Plantilla enviada (id ${sent.id}).`
    },
    {
      name: "send_template",
      description:
        "Envía una plantilla de WhatsApp autorizada (solo fuera de ventana o primer contacto).",
      schema: z.object({
        name: z.string().min(1),
        language: z.string().min(1),
        params: z.array(z.string()).default([]),
      }),
    },
  )

  const moveToStage = tool(
    async ({ stageId, opportunityId }: { stageId: string; opportunityId?: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se movería la oportunidad de etapa."
      return inOrg(async (tx) => {
        const moveMode = await getAutonomyPolicy(tx, ctx.orgId).then((p) => p.mover_oportunidad)
        if (moveMode !== "directo") {
          return `Bloqueado por la política de la clínica (mover_oportunidad=${moveMode}): no muevas etapas, deriva a humano.`
        }
        const { items } = await listOpportunities(tx, ctx.orgId, {
          contactId: ctx.contactId,
          status: "open",
          limit: 100,
        })
        if (items.length === 0) return "El contacto no tiene oportunidades abiertas: no hay etapa que mover."
        if (!opportunityId && items.length > 1) {
          const options = items.map((o) => `- ${o.title} (id ${o.id}, etapa ${o.stageName})`).join("\n")
          return `El contacto tiene varias oportunidades abiertas, pregunta cuál mover:\n${options}`
        }
        const chosen = opportunityId ? items.find((o) => o.id === opportunityId) : items[0]
        if (!chosen) return "Esa oportunidad no es del contacto o no está abierta: pide aclaración."
        await moveOpportunity(tx, ctx.orgId, chosen.id, stageId, undefined)
        return `Oportunidad ${chosen.title} movida a la etapa indicada.`
      })
    },
    {
      name: "move_to_stage",
      description:
        "Mueve una oportunidad abierta del contacto a otra etapa. Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: z.object({ stageId: z.string().uuid(), opportunityId: z.string().uuid().optional() }),
    },
  )

  const addTags = tool(
    async ({ tags }: { tags: string[] }) => {
      const contactId = ctx.contactId
      if (ctx.dryRun) return `[SIMULACIÓN] Se agregarían etiquetas: ${tags.join(", ")}.`
      const merged = await inOrg(async (tx) => {
        const current = await requireContact(tx, ctx.orgId, contactId)
        const next = [...new Set([...current.tags, ...tags])]
        await updateContact(tx, ctx.orgId, contactId, { tags: next }, { userId: null })
        return next
      })
      return `Etiquetas: ${merged.join(", ")}.`
    },
    {
      name: "add_tags",
      description: "Agrega etiquetas al contacto (p.ej. interesado-ortodoncia).",
      schema: z.object({ tags: z.array(z.string().min(1).max(40)).min(1).max(10) }),
    },
  )

  const updateContactTool = tool(
    async ({
      displayName,
      customFields,
    }: {
      displayName?: string
      customFields?: Record<string, unknown>
    }) => {
      const contactId = ctx.contactId
      if (ctx.dryRun) return "[SIMULACIÓN] Se actualizaría el contacto."
      await inOrg((tx) => updateContact(tx, ctx.orgId, contactId, { displayName, customFields }, { userId: null }))
      return "Contacto actualizado."
    },
    {
      name: "update_contact",
      description: "Actualiza nombre o campos personalizados del contacto.",
      schema: z.object({
        displayName: z.string().min(1).max(200).optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
      }),
    },
  )

  const createTaskTool = tool(
    async ({ title, dueAt }: { title: string; dueAt?: string }) => {
      const contactId = ctx.contactId
      if (ctx.dryRun) return `[SIMULACIÓN] Se crearía la tarea: ${title}.`
      const created = await inOrg((tx) =>
        createTask(tx, ctx.orgId, {
          title,
          ...(dueAt ? { dueAt } : {}),
          ...(contactId ? { contactId } : {}),
          conversationId: ctx.conversationId,
          createdBy: "agent",
        }),
      )
      return `Tarea creada (id ${created.id}).`
    },
    {
      name: "create_task",
      description: "Crea una tarea de seguimiento (llamar, confirmar, etc.).",
      schema: z.object({ title: z.string().min(1).max(200), dueAt: z.string().optional() }),
    },
  )

  const clinicInfo = tool(
    async () => {
      const snapshot = await inOrg((tx) => getClinicInfoSnapshot(tx, ctx.orgId))
      const lines = [`Clínica: ${snapshot.clinicName}.`]
      for (const b of snapshot.branches) {
        lines.push(
          `- Sede ${b.name} (id ${b.id}): ${[b.address, b.phone, b.mapsUrl].filter(Boolean).join(" · ") || "sin datos"}`,
        )
      }
      if (!snapshot.services.length) lines.push("Sin servicios publicados: no des precios.")
      for (const s of snapshot.services.slice(0, 50)) {
        lines.push(`- Servicio ${s.name} (id ${s.id}): S/ ${(s.priceCents / 100).toFixed(2)}${s.durationMin ? ` (${s.durationMin} min)` : ""}`)
      }
      return lines.join("\n")
    },
    {
      name: "ver_sedes_y_servicios",
      description:
        "Sedes (con id) y servicios con tarifas oficiales. Úsalo antes de hablar de precios, sedes o disponibilidad.",
      schema: z.object({}),
    },
  )

  const knowledgeSearch = tool(
    async ({ pregunta }: { pregunta: string }) => {
      const hits = await inOrg((tx) => searchPublishedKnowledge(tx, ctx.orgId, pregunta, 5))
      if (!hits.length) return "Sin respuesta oficial: no inventes, ofrece derivar a humano."
      return hits.map((h) => `- ${h.title}: ${h.body}`).join("\n")
    },
    {
      name: "consultar_conocimiento",
      description: "Busca respuestas oficiales publicadas de la clínica. Cítalas tal cual.",
      schema: z.object({ pregunta: z.string().min(2).max(300) }),
    },
  )

  const patientContext = tool(
    async ({ patientId }: { patientId?: string }) => {
      if (!patientId) {
        const candidates = await inOrg((tx) => listAgentContextCandidates(tx, ctx.orgId, ctx.contactId))
        if (!candidates.length) return "El interlocutor no está vinculado a ningún paciente: pide sus datos o deriva."
        return candidates
          .map((c) => `- ${c.displayName} (id ${c.patientId}, vínculo: ${c.relationship})`)
          .join("\n")
      }
      const found = await inOrg((tx) => resolveAgentPatientContext(tx, ctx.orgId, ctx.contactId, patientId))
      return `Paciente: ${found.displayName} (vínculo ${found.relationship}, autorización ${found.authorization}). Solo filiación mínima: nunca pidas ni reveles historia clínica.`
    },
    {
      name: "ver_contexto_paciente",
      description:
        "Sin id lista los pacientes vinculados al interlocutor; con id verifica vínculo y autorización. Nunca devuelve historia clínica.",
      schema: z.object({ patientId: z.string().uuid().optional() }),
    },
  )

  const patientSummary = tool(
    async ({ patientId }: { patientId: string }) => {
      const summary = await inOrg((tx) => getAgentPatientSummary(tx, ctx.orgId, ctx.contactId, patientId))
      const lines = [`Paciente: ${summary.context.displayName} (vínculo ${summary.context.relationship}).`]
      if (!summary.upcomingAppointments.length) {
        lines.push("Sin citas próximas.")
      }
      for (const a of summary.upcomingAppointments) {
        lines.push(
          `- Cita ${a.status} el ${new Date(a.startsAt).toLocaleString("es-PE")}, ${a.branchName} con ${a.dentistName}.`,
        )
      }
      for (const b of summary.budgets) {
        lines.push(`- Presupuesto N°${b.number} ${b.title}: ${b.status}.`)
      }
      if (summary.balance === null) {
        lines.push("Sin facultad para ver saldos: no los menciones ni los pidas.")
      } else if (!summary.balance.length || summary.balance.every((b) => b.outstandingCents <= 0)) {
        lines.push("Sin saldo pendiente.")
      } else {
        for (const b of summary.balance) {
          if (b.outstandingCents > 0) {
            lines.push(`- Saldo pendiente: ${(b.outstandingCents / 100).toFixed(2)} ${b.currency}.`)
          }
        }
      }
      return lines.join("\n")
    },
    {
      name: "ver_resumen_paciente",
      description:
        "Próximas citas y estado de presupuestos del paciente verificado; saldo solo si el interlocutor tiene facultad económica. Nunca historia clínica.",
      schema: z.object({ patientId: z.string().uuid() }),
    },
  )

  const availability = tool(
    async (input: {
      branchId: string
      from: string
      to: string
      durationMin: number
      dentistUserId?: string
      chairId?: string
      serviceId?: string
    }) => {
      const { gaps, truncated, timeZone } = await inOrg((tx) => findFreeGaps(tx, ctx.orgId, input))
      if (!gaps.length) return "Sin huecos en ese rango (quizá sin horario configurado): ofrece otro rango o deriva."
      const lines = gaps.map((g) => `- ${g.startsAt} → ${g.endsAt} (profesional ${g.dentistUserId})`)
      if (truncated) lines.push(`Hay más huecos (${timeZone}): acota el rango por días.`)
      return lines.join("\n")
    },
    {
      name: "buscar_huecos",
      description:
        "Huecos reales de agenda según horario del profesional y citas ocupantes. branchId, from/to ISO y durationMin obligatorios.",
      schema: z.object({
        branchId: z.string().uuid(),
        from: z.string().min(1),
        to: z.string().min(1),
        durationMin: z.number().int().min(10).max(480),
        dentistUserId: z.string().optional(),
        chairId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
      }),
    },
  )

  const proposeBooking = tool(
    async (input: {
      patientId: string
      dentistUserId: string
      chairId: string
      startsAt: string
      branchId?: string
      serviceId?: string
      durationMin?: number
      reason?: string
    }) => {
      const policy = await inOrg((tx) => getAutonomyPolicy(tx, ctx.orgId))
      const mode = policy.reservar_cita
      const key = `agent:${ctx.conversationId}:reservar_cita:${input.patientId}:${input.startsAt}`
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reservar (modo ${mode}): paciente ${input.patientId} el ${input.startsAt}.`
      }
      const proposal = await inOrg((tx) =>
        createProposal(tx, ctx.orgId, {
          conversationId: ctx.conversationId,
          action: "reservar_cita",
          payload: { ...input },
          reason: input.reason,
          idempotencyKey: key,
        }),
      )
      if (proposal.status === "ejecutada") return `Cita reservada (propuesta ${proposal.id}).`
      if (mode === "confirmar_usuario") {
        return `Propuesta ${proposal.id} creada: pide al paciente que confirme con un sí claro y luego usa confirmar_propuesta.`
      }
      return `Propuesta ${proposal.id} enviada a aprobación del equipo: avisa al paciente que lo contactaremos.`
    },
    {
      name: "proponer_cita",
      description:
        "Propone reservar una cita (verifica vínculo del paciente al ejecutar). Según la política puede pedir confirmación del paciente o aprobación del equipo.",
      schema: z.object({
        patientId: z.string().uuid(),
        dentistUserId: z.string().min(1),
        chairId: z.string().uuid(),
        startsAt: z.string().min(1),
        branchId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
        durationMin: z.number().int().min(10).max(480).optional(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const confirmProposal = tool(
    async ({ proposalId }: { proposalId: string }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se confirmaría la propuesta ${proposalId}.`
      const proposal = await inOrg((tx) => confirmProposalByContact(tx, ctx.orgId, ctx.contactId, proposalId))
      if (proposal.status === "ejecutada") return `Confirmado y ejecutado (propuesta ${proposal.id}).`
      return `Propuesta ${proposal.id} en estado ${proposal.status}.`
    },
    {
      name: "confirmar_propuesta",
      description: "Úsala SOLO cuando el paciente confirmó explícitamente el acto propuesto.",
      schema: z.object({ proposalId: z.string().uuid() }),
    },
  )

  const requestHandoff = tool(
    async ({ reason, summary, priority }: { reason: string; summary?: string; priority?: string }) => {
      if (ctx.dryRun) {
        await performHandoff(ctx, reason, summary)
        return `[SIMULACIÓN] Se derivaría a humano: ${reason}.`
      }
      const validPriority = priority === "alta" || priority === "baja" ? priority : "media"
      await inOrg((tx) =>
        createHandoff(tx, ctx.orgId, null, {
          conversationId: ctx.conversationId,
          reason,
          summary: summary?.trim() ? summary : reason,
          priority: validPriority,
          createdBy: "agent",
        }),
      )
      ctx.handedOff = true
      return "Derivado a humano. No envíes más mensajes."
    },
    {
      name: "request_human_handoff",
      description:
        "Deriva a un humano con motivo, resumen factual de lo conversado y prioridad (alta/media/baja). Apaga el agente.",
      schema: z.object({
        reason: z.string().min(1).max(300),
        summary: z.string().min(1).max(2000),
        priority: z.enum(["alta", "media", "baja"]).default("media"),
      }),
    },
  )

  return [
    sendReply,
    sendTemplate,
    moveToStage,
    addTags,
    updateContactTool,
    createTaskTool,
    clinicInfo,
    knowledgeSearch,
    patientContext,
    patientSummary,
    availability,
    proposeBooking,
    confirmProposal,
    requestHandoff,
  ]
}
