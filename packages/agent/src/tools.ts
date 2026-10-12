import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  buildAgentProposalKey,
  confirmProposalByContact,
  createHandoff,
  createProposal,
  createTask,
  deriveCommercialFollowUpCoordination,
  findFreeGaps,
  getAgentPatientSummary,
  getContact,
  getClinicInfoSnapshot,
  getOpportunity,
  getOrgLocale,
  formatOrgMoney,
  formatZoned,
  listAgentContextCandidates,
  listContactChannelHistory,
  listContactNotes,
  listOpportunities,
  listTasks,
  recordCommercialFollowUpProposal,
  requireContact,
  resolveAgentPatientContext,
  searchPublishedKnowledge,
  ServiceError,
  updateContact,
} from "@odentia/services"
import type { OpportunityDetail, OrgLocale, ProposalItem } from "@odentia/services"
import { z } from "zod"
export interface AgentToolCtx {
  db: Db
  orgId: string
  conversationId: string
  contactId: string
  /** Evento durable que disparó el turno (mensaje o coordinación). */
  triggerId: string | null
  secretsKey: Buffer
  /** La herramienta de handoff lo marca; el grafo termina el turno. */
  handedOff: boolean
  /** Simulación: las herramientas no escriben nada, solo describen. */
  dryRun: boolean
  /** Mensaje hipotético solo para simulación (no se persiste). */
  draftText?: string
  /** Instrucción interna adicional; nunca se representa como mensaje del interlocutor. */
  runInstruction?: string
  /** Restringe herramientas para disparadores operativos sin mensaje entrante. */
  allowedTools?: readonly string[]
  /** Herramientas que en este hilo no pueden servir; su esquema no se envía al modelo. */
  excludedTools?: readonly string[]
  commercialCoordinationId?: string
  /** Una coordinación proactiva ya produjo su único resultado terminal. */
  decisionRecorded: boolean
  /**
   * La respuesta al interlocutor quedó enviada o pendiente de decisión: el
   * grafo termina el turno sin volver a llamar al modelo.
   */
  replySettled: boolean
  /** Texto que la simulación habría enviado (no se persiste). */
  simulatedReply?: string
  /** Nombres de herramientas usadas en la corrida (supervisión). */
  toolsUsed: string[]
  /**
   * Tokens acumulados solo si el proveedor los reporta; `calls` cuenta las
   * llamadas al modelo siempre.
   */
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    calls: number
    reported: boolean
    cacheReported: boolean
  }
}

/**
 * Derivación a humano: registro estructurado (resumen, motivo, prioridad,
 * tarea), apaga el agente y avisa al equipo. Misma vía para keyword, tool y
 * maxTurns.
 */
export async function performHandoff(ctx: AgentToolCtx, reason: string, summary?: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.decisionRecorded = true
    ctx.handedOff = true
    return
  }
  await withOrgContext(ctx.db, ctx.orgId, async (tx) => {
    if (ctx.commercialCoordinationId) {
      await deriveCommercialFollowUpCoordination(
        tx,
        ctx.orgId,
        ctx.commercialCoordinationId,
        reason,
        summary?.trim() ? summary : reason,
      )
      return
    }
    await createHandoff(tx, ctx.orgId, null, {
      conversationId: ctx.conversationId,
      reason,
      summary: summary?.trim() ? summary : reason,
      priority: "media",
      createdBy: "agent",
    })
  })
  ctx.decisionRecorded = true
  ctx.handedOff = true
}

/**
 * Tools del agente. NUNCA SQL ni fetch arbitrario: solo servicios dentro
 * del contexto RLS de la org (invariante). En simulación (dryRun) las
 * mutaciones devuelven vista previa sin escribir.
 */
export function makeAgentTools(ctx: AgentToolCtx) {
  const inOrg = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withOrgContext(ctx.db, ctx.orgId, fn)

  // Configuración regional de la org, resuelta una vez por corrida: toda
  // fecha comunicada usa la zona de la sede de la cita o la de la org.
  let zonePromise: Promise<OrgLocale> | null = null
  const orgZone = (): Promise<OrgLocale> => (zonePromise ??= inOrg((tx) => getOrgLocale(tx, ctx.orgId)))

  /**
   * Ventana de WhatsApp cerrada: el modelo cambia a plantilla autorizada o
   * deriva. Llega persistida como `fallida` con `error` prefijado por el
   * código estable `WINDOW_CLOSED` y `result.errorCode` igual (pacto con
   * ProposalLifecycle, que ya no la lanza); se traduce a este texto.
   */
  const OUTSIDE_WINDOW =
    "outside_window: fuera de la ventana de 24h del canal. Si dispones de send_template, úsala con una plantilla autorizada; si no, deriva a humano."
  /**
   * Crea la propuesta comercial con clave estable por trigger + herramienta
   * + payload. En modo directo se ejecuta en el mismo acto; si exige
   * confirmación o aprobación, queda pendiente con su recorrido real. Los
   * errores de dominio en ejecución llegan como `fallida` con código estable
   * en `result.errorCode` y motivo prefijado en `error` (HTTP 200): se
   * reportan al modelo, nunca como aprobación. Si el hilo ya espera un «sí»
   * (PROPOSAL_PENDING_CONFIRM), se guía al modelo a pedir la confirmación;
   * si la pendiente es del equipo (PROPOSAL_PENDING_APPROVAL), se guía a
   * esperar al equipo sin pedir «sí» ni usar confirmar_propuesta.
   */
  const propose = async (
    action: string,
    payload: Record<string, unknown>,
    toolName: string,
    reason?: string,
  ): Promise<string> => {
    let proposal: ProposalItem
    try {
      proposal = await inOrg((tx) =>
        createProposal(tx, ctx.orgId, {
          conversationId: ctx.conversationId,
          action,
          payload,
          reason,
          idempotencyKey: buildAgentProposalKey({
            conversationId: ctx.conversationId,
            triggerId: ctx.triggerId,
            tool: toolName,
            payload,
          }),
          secretsKey: ctx.secretsKey,
        }),
      )
      const coordinationId = ctx.commercialCoordinationId
      if (coordinationId) {
        await inOrg((tx) =>
          recordCommercialFollowUpProposal(tx, ctx.orgId, coordinationId, proposal),
        )
        ctx.decisionRecorded = true
      }
    } catch (e) {
      if (e instanceof ServiceError && e.code === "PROPOSAL_PENDING_CONFIRM") {
        return "Ya hay una propuesta esperando la confirmación del interlocutor en este hilo: pídele que confirme con un sí claro y luego usa confirmar_propuesta, no crees otra."
      }
      if (e instanceof ServiceError && e.code === "PROPOSAL_PENDING_APPROVAL") {
        return "Ya hay una propuesta pendiente de decisión del equipo en este hilo. Informa al interlocutor de que el equipo la está revisando y espera su decisión; un sí del interlocutor no sustituye esa aprobación."
      }
      throw e
    }
    // Un mensaje enviado o a la espera de decisión cierra el turno; si falló
    // o expiró, el modelo aún debe cambiar a plantilla, reproponer o derivar.
    if (action === "enviar_mensaje" && proposal.status !== "fallida" && proposal.status !== "expirada") {
      ctx.replySettled = true
    }
    if (proposal.status === "ejecutada") return `Ejecutado en modo directo (propuesta ${proposal.id}).`
    if (proposal.status === "fallida") {
      const rawError = proposal.error?.trim() ?? ""
      if (rawError.startsWith("WINDOW_CLOSED") || proposal.result?.errorCode === "WINDOW_CLOSED") {
        return OUTSIDE_WINDOW
      }
      const detail = rawError ? `: ${rawError.slice(0, 300)}` : "."
      return `No se pudo ejecutar en modo directo (propuesta ${proposal.id})${detail} Ofrece una alternativa o deriva a humano.`
    }
    if (proposal.status === "expirada") {
      return `La propuesta ${proposal.id} expiró (48h): vuelve a proponer el acto con datos vigentes, no la confirmes.`
    }
    if (proposal.mode === "confirmar_usuario") {
      return `Propuesta ${proposal.id} creada: pide al interlocutor que confirme con un sí claro y luego usa confirmar_propuesta.`
    }
    return `Propuesta ${proposal.id} enviada a aprobación del equipo: avisa al interlocutor que lo contactaremos.`
  }

  /**
   * Elige una oportunidad abierta del contacto de ctx. La selección explícita
   * se verifica directa (pertenencia al contacto y estado abierto) para no
   * rechazarla por truncación de la lista. Sin id y con varias abiertas,
   * devuelve el mensaje para preguntar (nunca adivina ni toca oportunidades
   * de otro interlocutor).
   */
  const chooseOpportunity = async (opportunityId?: string): Promise<{ id: string } | { message: string }> => {
    if (opportunityId) {
      let detail: OpportunityDetail | null = null
      try {
        detail = await inOrg((tx) => getOpportunity(tx, ctx.orgId, opportunityId))
      } catch (e) {
        // Solo ausente equivale a ajena o cerrada; otro fallo se propaga.
        if (!(e instanceof ServiceError && e.code === "NOT_FOUND")) throw e
      }
      if (!detail || detail.contactId !== ctx.contactId || detail.status !== "open") {
        return { message: "Esa oportunidad no es del contacto o no está abierta: pide aclaración." }
      }
      return { id: detail.id }
    }
    const { items, nextCursor } = await inOrg((tx) =>
      listOpportunities(tx, ctx.orgId, { contactId: ctx.contactId, status: "open", limit: 100 }),
    )
    if (items.length === 0) return { message: "El contacto no tiene oportunidades abiertas." }
    if (items.length > 1) {
      const shown = items
        .slice(0, 20)
        .map((o) => `- ${o.title} (id ${o.id}, etapa ${o.stageName})`)
        .join("\n")
      const more =
        nextCursor || items.length > 20
          ? "\nHay más oportunidades: usa listar_oportunidades con el cursor para verlas todas antes de elegir."
          : ""
      return { message: `El contacto tiene varias oportunidades abiertas, pregunta cuál:\n${shown}${more}` }
    }
    const only = items[0]
    if (!only) return { message: "El contacto no tiene oportunidades abiertas." }
    return { id: only.id }
  }

  const sendReply = tool(
    async ({ text }: { text: string }) => {
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.simulatedReply = text
        return `[SIMULACIÓN] Se enviaría al interlocutor: ${text}`
      }
      // WINDOW_CLOSED ya no lanza: llega como `fallida` y propose la traduce
      // a outside_window. Lo que sí lanza (infra 429/5xx incluida) no
      // reintenta la corrida: ToolNode lo devuelve al modelo como mensaje.
      return propose("enviar_mensaje", { kind: "text", text }, "send_reply")
    },
    {
      name: "send_reply",
      description:
        "Envía la respuesta completa al interlocutor y cierra el turno: úsala al final, después de cualquier otra acción (queda como propuesta si la política no es directa). Si devuelve outside_window, sigue su indicación.",
      schema: z.object({ text: z.string().min(1).max(4000) }),
    },
  )

  const sendTemplate = tool(
    async ({ name, language, params }: { name: string; language: string; params: string[] }) => {
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.simulatedReply = `[plantilla ${name} · ${language}]`
        return `[SIMULACIÓN] Se enviaría plantilla ${name} (${language}).`
      }
      return propose("enviar_mensaje", { kind: "template", name, language, params }, "send_template")
    },
    {
      name: "send_template",
      description:
        "Envía una plantilla de WhatsApp autorizada y cierra el turno (propuesta si la política no es directa; solo fuera de ventana o primer contacto).",
      schema: z.object({
        name: z.string().min(1),
        language: z.string().min(1),
        params: z.array(z.string()).default([]),
      }),
    },
  )

  const moveToStage = tool(
    async ({ stageId, opportunityId }: { stageId: string; opportunityId?: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se propondría mover la oportunidad de etapa."
      const chosen = await chooseOpportunity(opportunityId)
      if ("message" in chosen) return chosen.message
      return propose("mover_oportunidad", { opportunityId: chosen.id, stageId }, "move_to_stage")
    },
    {
      name: "move_to_stage",
      description:
        "Mueve una oportunidad abierta del contacto a otra etapa (propuesta si la política no es directa). Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
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
        await updateContact(tx, ctx.orgId, contactId, { tags: next }, { userId: null, origin: "agent" })
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
      await inOrg((tx) => updateContact(tx, ctx.orgId, contactId, { displayName, customFields }, { userId: null, origin: "agent" }))
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
          // Misma clave estable que las propuestas: reentregar el mensaje no duplica la tarea.
          idempotencyKey: buildAgentProposalKey({
            conversationId: ctx.conversationId,
            triggerId: ctx.triggerId,
            tool: "create_task",
            payload: { title, dueAt: dueAt ?? null },
          }),
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
        lines.push(`- Servicio ${s.name} (id ${s.id}): ${formatOrgMoney(s.priceCents, s.currency, snapshot)}${s.durationMin ? ` (${s.durationMin} min)` : ""}`)
      }
      if (snapshot.paymentMethods.length) {
        lines.push("Medios de pago aceptados por la clínica (los mismos que ofrece caja):")
        for (const m of snapshot.paymentMethods) lines.push(`- ${m.name}`)
      }
      if (snapshot.promotions.length) {
        lines.push("Promociones vigentes (el precio «desde» es un mínimo: el final sale del presupuesto):")
        for (const p of snapshot.promotions) lines.push(`- ${p.name}`)
      }
      return lines.join("\n")
    },
    {
      name: "ver_sedes_y_servicios",
      description:
        "Sedes (con id), servicios con tarifas oficiales, medios de pago aceptados y promociones vigentes. Úsalo antes de hablar de precios, sedes, medios, promociones o disponibilidad.",
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
      description:
        "Busca respuestas oficiales publicadas por una palabra o frase literal del título o del texto; para el texto completo de una respuesta recortada pasa su título exacto. Cítalas tal cual.",
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
      const zone = await orgZone()
      const lines = [`Paciente: ${summary.context.displayName} (vínculo ${summary.context.relationship}).`]
      if (!summary.upcomingAppointments.length) {
        lines.push("Sin citas próximas.")
      }
      for (const a of summary.upcomingAppointments) {
        const cuando = formatZoned(new Date(a.startsAt), { timezone: a.branchTimezone ?? zone.timezone, locale: zone.locale })
        lines.push(
          `- Cita ${a.status} (id ${a.appointmentId}, versión ${a.version}) el ${cuando}, ${a.branchName} con ${a.dentistName}.`,
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
            lines.push(`- Saldo pendiente: ${formatOrgMoney(b.outstandingCents, b.currency, zone)}.`)
          }
        }
      }
      return lines.join("\n")
    },
    {
      name: "ver_resumen_paciente",
      description:
        "Próximas citas (con id y versión para reprogramar_cita/cancelar_cita) y estado de presupuestos del paciente verificado; saldo solo si el interlocutor tiene facultad económica. Nunca historia clínica.",
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
      const lines = gaps.map((g) => {
        const chair = g.chairId ?? "sin sillón asignado: filtra por un sillón real o deriva"
        return (
          `- ${g.startsAt} → ${g.endsAt} (${input.durationMin} min, zona ${timeZone})` +
          ` · sede ${input.branchId} · sillón ${chair} · profesional ${g.dentistUserId}`
        )
      })
      lines.push(
        "Usa los IDs exactos del hueco elegido en proponer_cita (sede, sillón y profesional): nunca inventes IDs.",
      )
      if (truncated) lines.push(`Hay más huecos (${timeZone}): acota el rango por días.`)
      return lines.join("\n")
    },
    {
      name: "buscar_huecos",
      description:
        "Huecos reales de agenda según horario del profesional y citas ocupantes. Antes de usarla confirma la sede real con ver_sedes_y_servicios y usa su ID exacto: branchId, from/to ISO y durationMin obligatorios. Cada hueco devuelve sede, sillón, profesional, inicio, fin, zona y duración para proponer_cita.",
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
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reservar: paciente ${input.patientId} el ${input.startsAt}.`
      }
      const { reason, ...payload } = input
      return propose("reservar_cita", payload, "proponer_cita", reason)
    },
    {
      name: "proponer_cita",
      description:
        "Propone reservar una cita con los IDs exactos de un hueco de buscar_huecos (sede, sillón, profesional, inicio). Verifica vínculo del paciente al ejecutar; según la política puede pedir confirmación del interlocutor o aprobación del equipo.",
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

  const rescheduleAppointment = tool(
    async (input: {
      appointmentId: string
      startsAt: string
      expectedVersion: number
      dentistUserId?: string
      chairId?: string
      reason?: string
    }) => {
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reprogramar la cita ${input.appointmentId} al ${input.startsAt}.`
      }
      const { reason, ...payload } = input
      return propose("reprogramar_cita", payload, "reprogramar_cita", reason)
    },
    {
      name: "reprogramar_cita",
      description:
        "Propone mover una cita existente a un nuevo inicio: nunca crea una reserva duplicada. Usa el id y la versión exactos de ver_resumen_paciente; con varias citas pregunta primero cuál corresponde y nunca actúes sobre pacientes no autorizados. Según la política puede pedir confirmación del interlocutor (confirmar_propuesta) o aprobación del equipo; la aprobación del equipo no sustituye la confirmación del interlocutor.",
      schema: z.object({
        appointmentId: z.string().uuid(),
        startsAt: z.string().min(1),
        expectedVersion: z.number().int().min(0),
        dentistUserId: z.string().optional(),
        chairId: z.string().uuid().optional(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const cancelAppointmentProposal = tool(
    async (input: { appointmentId: string; reason?: string }) => {
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría cancelar la cita ${input.appointmentId}.`
      }
      const { reason, ...payload } = input
      return propose("cancelar_cita", payload, "cancelar_cita", reason)
    },
    {
      name: "cancelar_cita",
      description:
        "Propone cancelar una cita existente (nunca la borra ni crea otra). Usa el id exacto de ver_resumen_paciente; con varias citas pregunta primero cuál corresponde. Según la política puede pedir confirmación del interlocutor (confirmar_propuesta) o aprobación del equipo; la respuesta indica el estado real: pendiente, ejecutada o fallida.",
      schema: z.object({
        appointmentId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const confirmProposal = tool(
    async ({ proposalId }: { proposalId: string }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se confirmaría la propuesta ${proposalId}.`
      let proposal: ProposalItem
      try {
        proposal = await inOrg((tx) =>
          confirmProposalByContact(tx, ctx.orgId, ctx.contactId, proposalId, { secretsKey: ctx.secretsKey }),
        )
      } catch (e) {
        if (e instanceof ServiceError && e.code === "PROPOSAL_NEEDS_TEAM_APPROVAL") {
          return "Esa propuesta exige aprobación del equipo: el sí del interlocutor no la ejecuta. Avísale de que el equipo la está revisando y espera su decisión."
        }
        if (e instanceof ServiceError && e.code === "PROPOSAL_NOT_CONTACT_CONFIRMABLE") return e.message
        throw e
      }
      if (proposal.status === "ejecutada") {
        if (proposal.action === "enviar_mensaje") ctx.replySettled = true
        return `Confirmado y ejecutado (propuesta ${proposal.id}).`
      }
      if (proposal.status === "fallida") {
        const rawError = proposal.error?.trim() ?? ""
        if (rawError.startsWith("WINDOW_CLOSED") || proposal.result?.errorCode === "WINDOW_CLOSED") return OUTSIDE_WINDOW
        const detail = rawError ? `: ${rawError.slice(0, 300)}` : "."
        return `No se pudo ejecutar al confirmar (propuesta ${proposal.id})${detail} Ofrece una alternativa o deriva a humano.`
      }
      if (proposal.status === "expirada") {
        return `La propuesta ${proposal.id} expiró (48h): pide de nuevo el acto al interlocutor para crear una nueva propuesta, no reintentes confirmar.`
      }
      return `Propuesta ${proposal.id} en estado ${proposal.status}.`
    },
    {
      name: "confirmar_propuesta",
      description:
        "Confirma un acto en modo confirmar_usuario cuando el interlocutor lo aprobó con un sí explícito. Jamás la uses para propuestas que requieren aprobación del equipo: esas las decide el equipo.",
      schema: z.object({ proposalId: z.string().uuid() }),
    },
  )
  const createOpportunityTool = tool(
    async (input: {
      title: string
      stageId?: string
      pipelineId?: string
      patientId?: string
      serviceId?: string
      interestText?: string
      amountCents?: number
      currency?: string
      nextActionAt?: string
      nextActionNote?: string
      reason?: string
    }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se propondría crear la oportunidad: ${input.title}.`
      const { reason, ...payload } = input
      return propose("crear_oportunidad", payload, "create_opportunity", reason)
    },
    {
      name: "create_opportunity",
      description:
        "Crea una oportunidad para el contacto de la conversación (propuesta si la política no es directa). El título es obligatorio; la etapa nace abierta.",
      schema: z.object({
        title: z.string().min(1).max(200),
        stageId: z.string().uuid().optional(),
        pipelineId: z.string().uuid().optional(),
        patientId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
        interestText: z.string().max(500).optional(),
        amountCents: z.number().int().min(0).optional(),
        currency: z.string().max(3).optional(),
        nextActionAt: z.string().optional(),
        nextActionNote: z.string().max(500).optional(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const updateFollowup = tool(
    async (input: { opportunityId?: string; nextActionAt?: string; nextActionNote?: string; reason?: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se propondría actualizar el seguimiento de la oportunidad."
      if (input.nextActionAt === undefined && input.nextActionNote === undefined) {
        return "Indica la fecha (nextActionAt ISO) o la nota (nextActionNote) del seguimiento."
      }
      const chosen = await chooseOpportunity(input.opportunityId)
      if ("message" in chosen) return chosen.message
      const payload: Record<string, unknown> = { opportunityId: chosen.id }
      if (input.nextActionAt !== undefined) payload["nextActionAt"] = input.nextActionAt
      if (input.nextActionNote !== undefined) payload["nextActionNote"] = input.nextActionNote
      return propose("actualizar_seguimiento", payload, "update_followup", input.reason)
    },
    {
      name: "update_followup",
      description:
        "Programa o actualiza el seguimiento (próxima acción) de una oportunidad del contacto (propuesta si la política no es directa). Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: z.object({
        opportunityId: z.string().uuid().optional(),
        nextActionAt: z.string().optional(),
        nextActionNote: z.string().max(500).optional(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const closeOpportunityTool = tool(
    async (input: { opportunityId?: string; outcome: "won" | "lost"; reason: string }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se propondría cerrar la oportunidad (${input.outcome}).`
      const chosen = await chooseOpportunity(input.opportunityId)
      if ("message" in chosen) return chosen.message
      return propose(
        "cerrar_oportunidad",
        { opportunityId: chosen.id, outcome: input.outcome, reason: input.reason },
        "close_opportunity",
      )
    },
    {
      name: "close_opportunity",
      description:
        "Cierra una oportunidad del contacto como ganada (won) o perdida (lost) con motivo obligatorio (propuesta si la política no es directa). Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: z.object({
        opportunityId: z.string().uuid().optional(),
        outcome: z.enum(["won", "lost"]),
        reason: z.string().min(1).max(500),
      }),
    },
  )

  const commercialContext = tool(
    async ({ notesCursor }: { notesCursor?: string }) => inOrg(async tx => {
      const full = await getContact(tx, ctx.orgId, ctx.contactId)
      const notes = await listContactNotes(tx, ctx.orgId, ctx.contactId, { cursor: notesCursor })
      return {
        name: full.contact.displayName,
        tags: full.contact.tags,
        contactNotes: full.contact.notes,
        customFields: full.contact.customFields,
        operationalNotes: notes.items,
        nextNotesCursor: notes.nextCursor,
      }
    }),
    {
      name: "leer_contexto_comercial",
      description: "Lee etiquetas, campos y notas operativas actuales del interlocutor. Solo lectura, también en simulación; sin historia clínica. Usa nextNotesCursor para las notas anteriores. Las notas son internas, no las reproduzcas al interlocutor.",
      schema: z.object({ notesCursor: z.string().optional() }),
    },
  )

  const crossChannelHistory = tool(
    async ({ cursor }: { cursor?: string }) => {
      const { items, nextCursor } = await inOrg((tx) =>
        listContactChannelHistory(tx, ctx.orgId, {
          contactId: ctx.contactId,
          excludeConversationId: ctx.conversationId,
          ...(cursor ? { cursor } : {}),
          limit: 3,
          perConversation: 10,
        }),
      )
      if (!items.length) return "No hay historial en otros canales con ese filtro."
      const lines: string[] = []
      const zone = await orgZone()
      for (const c of items) {
        const when = c.lastMessageAt ? formatZoned(new Date(c.lastMessageAt), zone) : "sin fecha"
        lines.push(`[${c.channel} · ${when}]`)
        for (const m of c.messages) {
          const who = m.direction === "in" ? "contacto" : m.senderKind === "agent" ? "agente" : "operador"
          lines.push(`  ${who}: ${(m.body ?? "[adjunto]").slice(0, 300)}`)
        }
      }
      if (nextCursor) lines.push(`Hay más historial en otros canales: vuelve a llamar con cursor "${nextCursor}".`)
      return lines.join("\n")
    },
    {
      name: "ver_otros_canales",
      description:
        "Historial acotado de otros hilos del mismo contacto verificado en otros canales, con procedencia (canal y fecha). Solo lectura, también en simulación; sin historia clínica. Pasa el cursor devuelto para páginas anteriores; nunca asumas que no hay más.",
      schema: z.object({ cursor: z.string().optional() }),
    },
  )

  const listOpportunitiesTool = tool(
    async ({ status, cursor, limit }: { status?: "open" | "won" | "lost"; cursor?: string; limit?: number }) => {
      const { items, nextCursor } = await inOrg((tx) =>
        listOpportunities(tx, ctx.orgId, {
          contactId: ctx.contactId,
          ...(status ? { status } : {}),
          ...(cursor ? { cursor } : {}),
          limit: limit ?? 20,
        }),
      )
      if (!items.length) return "El contacto no tiene oportunidades con ese filtro."
      const zone = await orgZone()
      const lines = items.map(
        (o) =>
          `- ${o.title} (id ${o.id}, etapa ${o.stageName}, estado ${o.status}${o.nextActionAt ? `, próxima acción ${formatZoned(new Date(o.nextActionAt), zone)}` : ""})`,
      )
      if (nextCursor) lines.push(`Hay más oportunidades: vuelve a llamar con cursor "${nextCursor}".`)
      return lines.join("\n")
    },
    {
      name: "listar_oportunidades",
      description:
        "Lista todas las oportunidades del contacto por páginas (el prompt solo trae las primeras). Pasa el cursor devuelto para ver más; nunca asumas que no hay más.",
      schema: z.object({
        status: z.enum(["open", "won", "lost"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
  )

  const listTasksTool = tool(
    async ({ status }: { status?: "open" | "done" | "cancelled" }) => {
      const items = await inOrg((tx) =>
        listTasks(tx, ctx.orgId, { contactId: ctx.contactId, ...(status ? { status } : {}) }),
      )
      if (!items.length) return "El contacto no tiene tareas con ese filtro."
      const zone = await orgZone()
      return items
        .map(
          (t) =>
            `- ${t.title} (id ${t.id}, estado ${t.status}${t.dueAt ? `, vence ${formatZoned(new Date(t.dueAt), zone)}` : ""}${t.opportunityTitle ? `, oportunidad ${t.opportunityTitle}` : ""})`,
        )
        .join("\n")
    },
    {
      name: "listar_tareas",
      description:
        "Lista todas las tareas del contacto (el prompt solo trae un resumen). Úsala antes de afirmar que no hay seguimientos.",
      schema: z.object({ status: z.enum(["open", "done", "cancelled"]).optional() }),
    },
  )

  const requestHandoff = tool(
    async ({ reason, summary, priority, assigneeUserId, message }: { reason: string; summary?: string; priority?: string; assigneeUserId?: string; message?: string }) => {
      const notice = message?.trim()
      if (ctx.dryRun) {
        await performHandoff(ctx, reason, summary)
        if (notice) {
          ctx.replySettled = true
          ctx.simulatedReply = notice
        }
        return `[SIMULACIÓN] Se derivaría a humano: ${reason}.`
      }
      if (ctx.commercialCoordinationId) {
        await performHandoff(ctx, reason, summary)
        return "Derivado a una persona usando el pendiente existente. No envíes más mensajes."
      }
      const validPriority = priority === "alta" || priority === "baja" ? priority : "media"
      const handoff = await inOrg((tx) =>
        createHandoff(tx, ctx.orgId, null, {
          conversationId: ctx.conversationId,
          reason,
          summary: summary?.trim() ? summary : reason,
          priority: validPriority,
          ...(assigneeUserId ? { assigneeUserId } : {}),
          createdBy: "agent",
        }),
      )
      ctx.handedOff = true
      const destino = handoff.assigneeUserId ? "con responsable asignado" : "en la cola del equipo por recoger"
      // El aviso sale después de crear la derivación: si esta falla, no se le
      // promete al interlocutor una atención que nadie registró.
      let noticeResult = ""
      if (notice) {
        const outcome = await propose("enviar_mensaje", { kind: "text", text: notice }, "request_human_handoff")
        noticeResult = ctx.replySettled ? " Aviso al interlocutor registrado." : ` El aviso al interlocutor no salió: ${outcome}`
      }
      return `Derivado a humano (${destino}, plazo ${handoff.dueAt ?? "sin plazo"}).${noticeResult} No envíes más mensajes.`
    },
    {
      name: "request_human_handoff",
      description:
        "Deriva a un humano con motivo, resumen factual de lo conversado y prioridad (alta/media/baja); sin assigneeUserId queda en la cola del equipo con plazo según prioridad. Apaga el agente y cierra el turno: pon en message el aviso breve para el interlocutor (por ejemplo, que una persona continuará la atención), porque después no podrás enviarle nada.",
      schema: z.object({
        reason: z.string().min(1).max(300),
        summary: z.string().min(1).max(2000),
        priority: z.enum(["alta", "media", "baja"]).default("media"),
        assigneeUserId: z.string().optional(),
        message: z.string().min(1).max(4000).optional(),
      }),
    },
  )

  const tools = [
    sendReply,
    sendTemplate,
    moveToStage,
    createOpportunityTool,
    updateFollowup,
    closeOpportunityTool,
    listOpportunitiesTool,
    listTasksTool,
    commercialContext,
    crossChannelHistory,
    addTags,
    updateContactTool,
    createTaskTool,
    clinicInfo,
    knowledgeSearch,
    patientContext,
    patientSummary,
    availability,
    proposeBooking,
    rescheduleAppointment,
    cancelAppointmentProposal,
    confirmProposal,
    requestHandoff,
  ]
  return tools.filter(
    (candidate) =>
      (!ctx.allowedTools || ctx.allowedTools.includes(candidate.name)) &&
      !ctx.excludedTools?.includes(candidate.name),
  )
}
