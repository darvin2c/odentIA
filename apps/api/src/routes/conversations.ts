import { withOrgContext } from "@odentia/db"
import {
  assignConversation,
  attachmentUrl,
  closeConversation,
  getConversationDetail,
  listConversations,
  listMessages,
  markRead,
  OUTBOUND_MEDIA_MAX_BYTES,
  OUTBOUND_MEDIA_MIME_EXT,
  reopenConversation,
  resolveConversationIdentity,
  sendOutbound,
  sendTemplateOutbound,
  setAgentStatus,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const listQuery = z.object({
  status: z.string().optional(),
  channel: z.string().optional(),
  assigned: z.string().optional(),
  q: z.string().optional(),
  view: z.enum(["unanswered", "human", "approval"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const textInput = z.object({ text: z.string().min(1).max(4000) })

const templateInput = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  params: z.array(z.string()).default([]),
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
    const { orgId } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listConversations(tx, orgId, parsed.data),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getConversationDetail(tx, orgId, c.req.param("id"))),
    )
  })

  app.get("/:id/messages", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = messagesQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listMessages(tx, orgId, c.req.param("id"), parsed.data),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/:id/messages", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = textInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendOutbound(tx, orgId, {
          conversationId: c.req.param("id"),
          senderKind: "user",
          senderUserId: userId,
          content: { type: "text", text: parsed.data.text },
        }),
      ),
    )
  })

  app.post("/:id/messages/template", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = templateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendTemplateOutbound(tx, orgId, deps.secretsKey, {
          conversationId: c.req.param("id"),
          senderKind: "user",
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
