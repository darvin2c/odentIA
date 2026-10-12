import { normalizeTags } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  addContactIdentity,
  addPersonFact,
  createContact,
  getContact,
  getPersonMemory,
  listContacts,
  moveContactIdentity,
  operationBodySchema,
  removePersonFact,
  startContactConversation,
  updateContact,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
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
  givenNames: z.string().max(100).nullable().optional(),
  paternalSurname: z.string().max(100).nullable().optional(),
  maternalSurname: z.string().max(100).nullable().optional(),
  docCountry: z.string().max(2).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  preferredChannel: z.enum(["email", "whatsapp", "telegram", "messenger", "instagram"]).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  docType: z.string().max(20).nullable().optional(),
  docNumber: z.string().max(20).nullable().optional(),
  birthDate: z.string().max(10).nullable().optional(),
  sex: z.string().max(1).nullable().optional(),
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

  /**
   * Lo que el agente recuerda de la persona. Lo lee quien atiende
   * conversaciones o lleva el CRM; añadir o quitar un dato exige escribir en
   * uno de los dos. El dato pasa el mismo filtro que cuando lo guarda el
   * agente: nada clínico.
   */
  const memoryReaders = ["conversations.read", "crm.read"] as const
  const memoryWriters = ["conversations.write", "crm.write"] as const
  // Los campos de recordar un dato se declaran una vez, para la pantalla y para el agente.
  const factInput = operationBodySchema("persona.recordar")

  app.get("/:id/agent-memory", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, [...memoryReaders])) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso a esta persona"), 403)
    // «La última vez» incluye su cita solo para quien ve la agenda.
    const lastTime = { appointments: canAccess(memberRole, "appointments.read") }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPersonMemory(tx, orgId, c.req.param("id"), { lastTime })))
  })

  app.post("/:id/agent-memory", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccessAny(memberRole, [...memoryWriters])) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para cambiar lo que recuerda el agente"), 403)
    const parsed = factInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addPersonFact(tx, orgId, { userId, source: "equipo" }, { contactId: c.req.param("id"), ...parsed.data }),
      ),
    )
  })

  app.post("/:id/agent-memory/:factId/remove", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccessAny(memberRole, [...memoryWriters])) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para cambiar lo que recuerda el agente"), 403)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => removePersonFact(tx, orgId, userId, c.req.param("id"), c.req.param("factId")))
      return { ok: true }
    })
  })

  return app
}
