import { withOrgContext } from "@odentia/db"
import {
  BLOCK_REASONS,
  blockPerson,
  confirmPhoneMatch,
  contactOfConversation,
  markSpamAndRefund,
  takeOutOfSpam,
  unblockPerson,
  phoneMatchOf,
  assignConversation,
  attachmentUrl,
  CONVERSATION_STATUSES,
  CONVERSATION_VIEWS,
  closeConversation,
  getInboxConversationDetail,
  getResolvePreview,
  listApprovedMessages,
  getConversationContext,
  listAgentActions,
  listInboxConversations,
  listPersonMessages,
  markRead,
  orgProduct,
  OUTBOUND_MEDIA_MAX_BYTES,
  OUTBOUND_MEDIA_MIME_EXT,
  releaseConversation,
  reopenConversation,
  resolveConversationByTeam,
  resolveConversationIdentity,
  sendApprovedMessage,
  sendOutbound,
  sendTeamReply,
  replyByWhatsApp,
  deleteWebchatTest,
  takeTopic,
  resolveTopic,
  setAgentStatus,
  summarizeInbox,
  takeConversation,
} from "@odentia/services"
import { ORG_ROLES, type OrgRole, roleLabel } from "@odentia/auth/permissions"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const filtersQuery = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  channel: z.string().optional(),
  assigned: z.string().optional(),
  // «Solo las mías»: los temas de quien consulta y los que nadie tomó.
  mine: z.enum(["1"]).optional(),
  q: z.string().optional(),
})

const listQuery = filtersQuery.extend({
  view: z.enum(CONVERSATION_VIEWS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const textInput = z.object({
  text: z.string().min(1).max(4000),
  // Responder citando un mensaje de la persona (ADR 0050).
  replyToMessageId: z.string().uuid().optional(),
  // «Enviar, sigue pendiente»: el tema queda abierto. Por defecto se resuelve.
  keepPending: z.boolean().optional(),
})

const approvedInput = z.object({
  messageId: z.string().min(1).max(80),
  // Solo en plantillas de la cuenta que piden datos: los escribe quien envía.
  values: z.array(z.string().max(1000)).max(20).optional(),
})

const assignInput = z.object({ userId: z.string().nullable() })

const agentInput = z.object({ enabled: z.boolean() })

const messagesQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export function createConversationsRoute(deps: CrmDeps) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    if (!canAccess(memberRole, write ? "conversations.write" : "conversations.read")) {
      return c.json(
        errorBody(
          c,
          "FORBIDDEN",
          write ? "No tienes permiso para escribir en conversaciones" : "No tienes permiso para ver conversaciones",
        ),
        403,
      )
    }
    await next()
  })

  app.get("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { mine, ...filters } = parsed.data
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listInboxConversations(tx, orgId, { ...filters, ...(mine ? { mineOf: userId } : {}) }),
      )
      // Quien no ve al agente sabe que hizo algo, no el detalle de lo que propuso.
      const seesAgent = canAccess(memberRole, "agent.read") || canAccess(memberRole, "agent.decide")
      return c.json({
        data: seesAgent ? items : items.map((item) => ({ ...item, lastAction: item.lastAction ? { ...item.lastAction, what: null } : null })),
        nextCursor,
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  // Totales de las vistas de la bandeja con los mismos filtros que la lista.
  // Registrado antes de `/:id` para que «summary» no se lea como un id.
  app.get("/summary", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = filtersQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { mine, ...filters } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => summarizeInbox(tx, orgId, { ...filters, ...(mine ? { mineOf: userId } : {}) })),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getInboxConversationDetail(tx, orgId, c.req.param("id"))),
    )
  })

  // Lo que hizo el agente con esta persona: lo que cada rol no puede ver queda en una línea sin detalle.
  app.get("/:id/agent-actions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAgentActions(tx, orgId, c.req.param("id"), {
          appointments: canAccess(memberRole, "appointments.read"),
          budgets: canAccess(memberRole, "budgets.read"),
          crm: canAccess(memberRole, "crm.read"),
          agent: canAccess(memberRole, "agent.read") || canAccess(memberRole, "agent.decide"),
        }),
      ),
    )
  })

  // «Contexto»: quién es y una línea por cada sección que este rol puede abrir.
  app.get("/:id/context", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getConversationContext(tx, orgId, c.req.param("id"), (permission) => canAccess(memberRole, permission)),
      ),
    )
  })

  // «Este número es el teléfono de Carmen Ruiz. ¿Es ella?» (decisión 23, caso 3):
  // la sugerencia nunca une sola; «Sí, es Carmen» la confirma una persona del equipo.
  app.get("/:id/phone-match", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const match = await phoneMatchOf(tx, orgId, c.req.param("id"))
        return match ? { personId: match.personId, personName: match.personName } : null
      }),
    )
  })

  app.post("/:id/phone-match", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = z.object({ personId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => confirmPhoneMatch(tx, orgId, userId, c.req.param("id"), parsed.data.personId)),
    )
  })

  // «Cargar anteriores» del hilo: la línea de tiempo de todos los canales de la persona (fase 4 del pulido).
  app.get("/:id/messages", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = messagesQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listPersonMessages(tx, orgId, c.req.param("id"), parsed.data),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  // Temas de la conversación (ADR 0050): tomar, pasar a otra persona y resolver.
  app.post("/:id/topics/:topicId/take", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = z.object({ toUserId: z.string().min(1).max(100).optional() }).strict()
      .safeParse((await c.req.json().catch(() => ({}))) ?? {})
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        takeTopic(tx, orgId, {
          conversationId: c.req.param("id"),
          topicId: c.req.param("topicId"),
          userId,
          ...(parsed.data.toUserId ? { toUserId: parsed.data.toUserId } : {}),
        }),
      ),
    )
  })

  app.post("/:id/topics/:topicId/resolve", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await resolveTopic(tx, orgId, { conversationId: c.req.param("id"), topicId: c.req.param("topicId"), userId })
        return { ok: true }
      }),
    )
  })

  app.post("/:id/messages", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = textInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendTeamReply(tx, orgId, {
          conversationId: c.req.param("id"),
          userId,
          content: { type: "text", text: parsed.data.text },
          replyToMessageId: parsed.data.replyToMessageId ?? null,
          keepPending: parsed.data.keepPending ?? false,
        }),
      ),
    )
  })

  // «Borrar esta prueba» (fase 6 del pulido): solo una prueba del chat web, con todo lo que dejó.
  app.post("/:id/delete-test", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({ deleted: await deleteWebchatTest(tx, orgId, { conversationId: c.req.param("id") }) })),
    )
  })

  // «Escribirle por WhatsApp» (tablero 4b del pulido): desde Instagram o
  // Messenger pasadas las 24 horas, a su WhatsApp con «Ver respuesta».
  app.post("/:id/messages/whatsapp", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = textInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        replyByWhatsApp(tx, orgId, {
          conversationId: c.req.param("id"),
          userId,
          text: parsed.data.text,
          replyToMessageId: parsed.data.replyToMessageId ?? null,
          keepPending: parsed.data.keepPending ?? false,
        }),
      ),
    )
  })

  /**
   * Los mensajes aprobados que se pueden enviar a mano en esta conversación,
   * con los datos de la persona ya puestos, o por qué no hay ninguno.
   */
  app.get("/:id/approved-messages", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    try {
      const result = await withOrgContext(deps.db, orgId, (tx) =>
        listApprovedMessages(tx, orgId, c.req.param("id"), (permission) => canAccess(memberRole, permission)),
      )
      return c.json({ data: result.data, none: result.none })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/:id/messages/approved", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = approvedInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendApprovedMessage(tx, orgId, deps.secretsKey, {
          conversationId: c.req.param("id"),
          senderUserId: userId,
          ...parsed.data,
        }),
      ),
    )
  })

  app.post("/:id/messages/media", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const conversationId = c.req.param("id")
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) {
      return c.json(errorBody(c, "VALIDATION", "Adjunta un archivo"), 400)
    }
    const ext = OUTBOUND_MEDIA_MIME_EXT[file.type]
    if (!ext) {
      return c.json(
        errorBody(c, "VALIDATION", "Tipo de archivo no admitido (JPG, PNG, WebP, PDF, OGG o MP3)"),
        400,
      )
    }
    if (file.size > OUTBOUND_MEDIA_MAX_BYTES) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 16 MB"), 400)
    }
    const captionRaw = form?.get("caption")
    const caption =
      typeof captionRaw === "string" && captionRaw.trim()
        ? captionRaw.trim().slice(0, 1000)
        : undefined
    const bytes = new Uint8Array(await file.arrayBuffer())
    return runService(c, 201, async () => {
      const ref = await deps.storage.putAttachment({
        orgId,
        conversationId,
        bytes,
        contentType: file.type,
        ext,
      })
      try {
        return await withOrgContext(deps.db, orgId, (tx) =>
          sendOutbound(tx, orgId, {
            conversationId,
            senderKind: "user",
            senderUserId: userId,
            // putAttachment devuelve como filename el basename del objectKey;
            // el operador debe ver el nombre original del archivo.
            content: { type: "media", attachment: { ...ref, filename: file.name }, caption },
          }),
        )
      } catch (e) {
        await deps.storage.deleteAttachment(ref.objectKey).catch(() => {})
        throw e
      }
    })
  })

  app.post("/:id/read", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => markRead(tx, orgId, c.req.param("id"))).then(() => ({
        ok: true,
      })),
    )
  })

  app.post("/:id/assign", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = assignInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        assignConversation(tx, orgId, c.req.param("id"), parsed.data.userId, userId),
      ).then(() => ({ ok: true })),
    )
  })

  /** «Tomar»: la conversación pasa a quien la toma, el agente se apaga en el hilo y sus casos derivados quedan a su nombre. */
  app.post("/:id/take", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => takeConversation(tx, orgId, c.req.param("id"), userId)).then(() => ({ ok: true })),
    )
  })

  /** «Devolver al agente»: sin asignación y con el agente encendido; con un caso derivado abierto, 409 `HANDOFF_OPEN`. */
  app.post("/:id/release", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => releaseConversation(tx, orgId, c.req.param("id"), userId)).then(() => ({ ok: true })),
    )
  })

  /** Lo que pasará al pulsar «Resolver»: si sale la despedida (y cuál), cuántos casos y propuestas se cierran. */
  app.get("/:id/resolve-preview", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getResolvePreview(tx, orgId, c.req.param("id"))),
    )
  })

  /** «Resolver»: despedida si se puede escribir, casos derivados resueltos, propuestas vencidas y cierre por el equipo. */
  app.post("/:id/resolve", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const id = c.req.param("id")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await resolveConversationByTeam(tx, orgId, id, userId)
        return getInboxConversationDetail(tx, orgId, id)
      }),
    )
  })

  /** Cerrar sin resolver un caso: sin despedida; los casos derivados quedan «cerrados sin resolver». */
  app.post("/:id/close", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        closeConversation(tx, orgId, c.req.param("id"), userId),
      ).then(() => ({
        ok: true,
      })),
    )
  })

  app.post("/:id/reopen", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reopenConversation(tx, orgId, c.req.param("id"), userId),
      ).then(() => ({
        ok: true,
      })),
    )
  })

  app.post("/:id/agent", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = agentInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAgentStatus(tx, orgId, c.req.param("id"), parsed.data.enabled, userId),
      ).then(() => ({ ok: true })),
    )
  })

  /** La persona de una conversación, para Spam y Bloquear: actúan sobre ella, no sobre el hilo (ADR 0054). */
  const contactOf = contactOfConversation

  // «Es spam»: quien escribe en conversaciones. No vale para un paciente (409).
  // Sus conversaciones ya cobradas se devuelven solas dentro del tope (decisión 5).
  app.post("/:id/spam", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const role = (ORG_ROLES as readonly string[]).includes(memberRole) ? (memberRole as OrgRole) : null
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const contactId = await contactOf(tx, orgId, c.req.param("id"))
        const label = role ? roleLabel(role, await orgProduct(tx, orgId)) : memberRole
        return markSpamAndRefund(tx, orgId, { userId, roleLabel: label }, contactId)
      }),
    )
  })

  // «No es spam»: vuelve a la Bandeja y queda protegida; el agente le responde si aún se puede.
  app.post("/:id/not-spam", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const contactId = await contactOf(tx, orgId, c.req.param("id"))
        return takeOutOfSpam(tx, orgId, { contactId, userId })
      }),
    )
  })

  const blockInput = z.object({ reason: z.enum(BLOCK_REASONS), note: z.string().trim().min(1).max(500) }).strict()

  // Bloquear y desbloquear: solo quien maneja los contactos (recepción, dueño y administración).
  app.post("/:id/block", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para bloquear a una persona"), 403)
    }
    const parsed = blockInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const contactId = await contactOf(tx, orgId, c.req.param("id"))
        await blockPerson(tx, orgId, { contactId, userId, reason: parsed.data.reason, note: parsed.data.note })
        return { ok: true }
      }),
    )
  })

  app.post("/:id/unblock", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para desbloquear a una persona"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const contactId = await contactOf(tx, orgId, c.req.param("id"))
        await unblockPerson(tx, orgId, { contactId, userId })
        return { ok: true }
      }),
    )
  })

  const identityInput = z.object({ identityId: z.string().uuid() })

  app.put("/:id/identity", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = identityInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        resolveConversationIdentity(tx, orgId, c.req.param("id"), parsed.data, { userId }),
      ),
    )
  })

  app.get("/:id/messages/:messageId/attachments/:index", async (c) => {
    const { orgId } = orgContextOf(c)
    const index = Number(c.req.param("index"))
    if (!Number.isInteger(index) || index < 0) {
      return c.json(errorBody(c, "VALIDATION", "Índice inválido"), 400)
    }
    try {
      const url = await withOrgContext(deps.db, orgId, (tx) =>
        attachmentUrl(tx, orgId, c.req.param("messageId"), index, deps.storage),
      )
      return c.redirect(url, 302)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
