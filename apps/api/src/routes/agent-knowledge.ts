import { withOrgContext } from "@odentia/db"
import {
  answerKnowledgeGaps,
  createKnowledgeEntry,
  discardKnowledgeGaps,
  getAgentDataSources,
  getKnowledgeBasics,
  getKnowledgeEntry,
  listKnowledgePage,
  listKnowledgeGaps,
  listKnowledgeRevisions,
  setKnowledgeStatus,
  updateKnowledgeEntry,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Elige una fecha válida.")
/** Mismas palabras que el cajón de conocimiento y que el servicio (`knowledge.ts`). */
const title = z.string().min(1, "Escribe la pregunta.").max(200, "Escribe como mucho 200 caracteres.")
const body = z.string().min(1, "Escribe la respuesta.").max(8000, "Escribe como mucho 8000 caracteres.")
const basicKey = z.string().max(40).nullable().optional()
const catalog = {
  branchId: z.string().uuid().nullable().optional(),
  validFrom: day.nullable().optional(),
  validUntil: day.nullable().optional(),
  askForms: z
    .array(z.string().max(120, "Cada forma de preguntar admite hasta 120 caracteres."))
    .max(20, "Escribe hasta 20 formas de preguntar, una por línea.")
    .optional(),
  basicKey,
}

const createInput = z.object({
  kind: z.enum(["faq", "info_sede", "politica"]),
  title,
  body,
  ...catalog,
})

const updateInput = z.object({
  title: title.optional(),
  body: body.optional(),
  ...catalog,
})

const gapIds = z.array(z.string().uuid()).min(1).max(100)
/**
 * Cerrar preguntas sin respuesta: con una respuesta que ya existe (`entryId`)
 * o con una nueva. Un solo objeto (no una unión) para que cada error diga su
 * campo: sin `entryId`, la pregunta y la respuesta son obligatorias.
 */
const answerGapsInput = z
  .object({
    ids: gapIds,
    entryId: z.string().uuid().optional(),
    title: title.optional(),
    body: body.optional(),
    basicKey,
  })
  .superRefine((input, ctx) => {
    if (input.entryId) return
    if (input.title === undefined) ctx.addIssue({ code: "custom", path: ["title"], message: "Escribe la pregunta." })
    if (input.body === undefined) ctx.addIssue({ code: "custom", path: ["body"], message: "Escribe la respuesta." })
  })

const statusInput = z.object({ status: z.enum(["borrador", "publicada"]) })

export function createAgentKnowledgeRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    const query = {
      kind: c.req.query("kind"),
      status: c.req.query("status"),
      branchId: c.req.query("branchId"),
      q: c.req.query("q"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      cursor: c.req.query("cursor"),
    }
    // Por páginas: `nextCursor` sigue y `total` cuenta todas las que cumplen el filtro.
    try {
      const page = await withOrgContext(deps.db, orgId, (tx) => listKnowledgePage(tx, orgId, query))
      return c.json({ data: page.items, nextCursor: page.nextCursor, total: page.total })
    } catch (error) {
      const handled = serviceErrorResponse(c, error)
      if (handled) return handled
      throw error
    }
  })

  /** «Lo que solo tú sabes»: cuáles de esas preguntas ya tienen respuesta oficial. */
  app.get("/basics", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getKnowledgeBasics(tx, orgId)))
  })

  /** «Lo que toma de tus datos»: lo que el agente lee en el momento, contado (ADR 0120). */
  app.get("/sources", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAgentDataSources(tx, orgId)))
  })

  /** Lo que el agente no supo responder, agrupado, con lo que respondió el equipo. */
  app.get("/gaps", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    const parsed = z
      .object({
        status: z.enum(["abierta", "resuelta", "descartada"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listKnowledgeGaps(tx, orgId, parsed.data)))
  })

  app.post("/gaps/answer", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = answerGapsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { ids, entryId, title, body, basicKey } = parsed.data
    const answer = entryId ? { entryId } : { title: title ?? "", body: body ?? "", basicKey: basicKey ?? null }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => answerKnowledgeGaps(tx, orgId, userId, ids, answer)),
    )
  })

  app.post("/gaps/discard", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = z.object({ ids: gapIds }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => discardKnowledgeGaps(tx, orgId, userId, parsed.data.ids))
      return { discarded: parsed.data.ids.length }
    })
  })

  app.post("/", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createKnowledgeEntry(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getKnowledgeEntry(tx, orgId, c.req.param("id"))),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = updateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateKnowledgeEntry(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })

  app.post("/:id/status", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = statusInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setKnowledgeStatus(tx, orgId, userId, c.req.param("id"), parsed.data.status)),
    )
  })

  app.get("/:id/revisions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listKnowledgeRevisions(tx, orgId, c.req.param("id"))),
    )
  })

  return app
}
