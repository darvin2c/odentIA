import { normalizeTags } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  addContactIdentity,
  createContact,
  getContact,
  listContacts,
  moveContactIdentity,
  startContactConversation,
  updateContact,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const listQuery = z.object({
  q: z.string().optional(),
  isActive: z.enum(["true", "false", "all"]).optional().default("true"),
  sort: z.enum(["nombre", "-nombre", "actividad", "-actividad"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

// Etiquetas crudas: se acepta forma sin normalizar (mayúsculas, espacios,
// guiones/underscore) y se normaliza con el helper canónico antes de validar
// límites/dedup. Los límites canónicos (20 únicas, 40 caracteres) los impone
// normalizeTags; el servicio vuelve a normalizar (idempotente, sin bypass).
const rawTags = z.array(z.string().min(1).max(200)).max(100).optional()

const contactFields = {
  phone: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
}

const createInput = z.object({
  displayName: z.string().min(1).max(200),
  ...contactFields,
  notes: z.string().max(2000).optional(),
  tags: rawTags,
  assignedUserId: z.string().nullable().optional(),
})

const patchInput = z.object({
  displayName: z.string().min(1).max(200).optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  tags: rawTags,
  assignedUserId: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
})

export function createContactsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { isActive, ...rest } = parsed.data
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listContacts(tx, orgId, {
          ...rest,
          isActive: isActive === "all" ? "all" : isActive === "false" ? false : true,
        }),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    let tags: string[] | undefined
    if (parsed.data.tags !== undefined) {
      try {
        tags = normalizeTags(parsed.data.tags)
      } catch (e) {
        return c.json(
          errorBody(c, "VALIDATION", e instanceof Error ? e.message : "Etiquetas inválidas"),
          400,
        )
      }
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createContact(tx, orgId, { ...parsed.data, tags }, { userId }),
      ),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getContact(tx, orgId, c.req.param("id"))),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    let tags: string[] | undefined
    if (parsed.data.tags !== undefined) {
      try {
        tags = normalizeTags(parsed.data.tags)
      } catch (e) {
        return c.json(
          errorBody(c, "VALIDATION", e instanceof Error ? e.message : "Etiquetas inválidas"),
          400,
        )
      }
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateContact(tx, orgId, c.req.param("id"), { ...parsed.data, tags }, { userId }),
      ),
    )
  })

  const identityInput = z.object({
    channel: z.enum(["whatsapp", "telegram", "messenger", "instagram"]),
    externalUserId: z.string().min(1).max(100),
  })

  app.post("/:id/identities", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "conversations.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de escritura de conversaciones"),
        403,
      )
    }
    const parsed = identityInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addContactIdentity(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  const moveInput = z.object({
    toContactId: z.string().uuid(),
    reason: z.string().min(1).max(500),
  })

  app.post("/:id/identities/:identityId/move", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "conversations.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de escritura de conversaciones"),
        403,
      )
    }
    const parsed = moveInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        moveContactIdentity(tx, orgId, userId, c.req.param("identityId"), { fromContactId: c.req.param("id"), ...parsed.data }),
      ),
    )
  })

  const startConversationInput = z.object({
    identityId: z.string().uuid(),
    connectionId: z.string().uuid(),
  })

  app.post("/:id/conversations", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "conversations.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de escritura de conversaciones"),
        403,
      )
    }
    const parsed = startConversationInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const result = await withOrgContext(deps.db, orgId, (tx) =>
        startContactConversation(tx, orgId, userId, c.req.param("id"), parsed.data),
      )
      return c.json({ data: result }, result.created ? 201 : 200)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
