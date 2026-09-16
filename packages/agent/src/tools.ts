import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  createTask,
  requireContact,
  ServiceError,
  sendOutbound,
  sendTemplateOutbound,
  setAgentStatus,
  setStage,
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
}

/**
 * Derivación a humano: apaga el agente, crea tarea de seguimiento y marca
 * el contexto para terminar. Misma vía para keyword, tool y maxTurns.
 */
export async function performHandoff(ctx: AgentToolCtx, reason: string): Promise<void> {
  await withOrgContext(ctx.db, ctx.orgId, async (tx) => {
    await setAgentStatus(tx, ctx.orgId, ctx.conversationId, false)
    await createTask(tx, ctx.orgId, {
      title: `Derivación a humano: ${reason}`.slice(0, 200),
      conversationId: ctx.conversationId,
      createdBy: "agent",
    })
  })
  ctx.handedOff = true
}

/**
 * Tools del agente. NUNCA SQL ni fetch arbitrario: solo servicios dentro
 * del contexto RLS de la org (invariante).
 */
export function makeAgentTools(ctx: AgentToolCtx) {
  const inOrg = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withOrgContext(ctx.db, ctx.orgId, fn)

  const sendReply = tool(
    async ({ text }: { text: string }) => {
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
    async ({ stageId }: { stageId: string }) => {
      await inOrg((tx) => setStage(tx, ctx.orgId, ctx.contactId, stageId))
      return "Etapa actualizada."
    },
    {
      name: "move_to_stage",
      description: "Mueve el contacto a una etapa del pipeline (usa el stageId exacto).",
      schema: z.object({ stageId: z.string().uuid() }),
    },
  )

  const addTags = tool(
    async ({ tags }: { tags: string[] }) => {
      const contactId = ctx.contactId
      const merged = await inOrg(async (tx) => {
        const current = await requireContact(tx, ctx.orgId, contactId)
        const next = [...new Set([...current.tags, ...tags])]
        await updateContact(tx, ctx.orgId, contactId, { tags: next })
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
      await inOrg((tx) => updateContact(tx, ctx.orgId, contactId, { displayName, customFields }))
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

  const requestHandoff = tool(
    async ({ reason }: { reason: string }) => {
      await performHandoff(ctx, reason)
      return "Derivado a humano. No envíes más mensajes."
    },
    {
      name: "request_human_handoff",
      description: "Deriva a un humano (queja, caso clínico, fuera de alcance). Apaga el agente.",
      schema: z.object({ reason: z.string().min(1).max(300) }),
    },
  )

  return [
    sendReply,
    sendTemplate,
    moveToStage,
    addTags,
    updateContactTool,
    createTaskTool,
    requestHandoff,
  ]
}
