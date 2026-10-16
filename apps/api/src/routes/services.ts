import { withOrgContext } from "@odentia/db"
import { PRICE_DISCLOSURES } from "@odentia/db/schema/clinical"
import {
  createService,
  getService,
  getTemplate,
  listMostUsedServices,
  listServices,
  listTemplates,
  PRICE_DISCLOSURE_BATCH,
  quickAddServices,
  setServicesPriceDisclosure,
  updateService,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

// Catálogo visible para clínica (dentista), configuración y caja: el dentista
// lo necesita para planificar y la caja para cobrar; la escritura es ajuste.

const templatesQuery = z
  .object({
    q: z.string().max(200).optional(),
    specialty: z.string().max(40).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

const offersQuery = z
  .object({
    q: z.string().max(200).optional(),
    /** Especialidad de la clínica (id). */
    specialtyId: z.string().uuid().optional(),
    state: z.enum(["active", "inactive", "legacy"]).optional(),
    /** Solo estos servicios, en cualquier estado (separados por coma): nombrar lo ya elegido. */
    ids: z
      .string()
      .max(3800)
      .transform((value) => value.split(",").map((id) => id.trim()).filter(Boolean))
      .pipe(z.array(z.string().uuid()).min(1).max(100))
      .optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

/**
 * Qué deja el servicio en la pieza al completarse (lo tratado queda dibujado):
 * el hallazgo y, si corresponde, su variante; `null` = nada. El servicio valida
 * con el ámbito y la regla del país de la clínica.
 */
const leavesFindingInput = z
  .object({
    condition: z.string().trim().min(1).max(80),
    variant: z.string().trim().min(1).max(80).nullish(),
  })
  .strict()
  .transform(({ condition, variant }) => (variant ? { condition, variant } : { condition }))

const createInput = z
  .object({
    templateId: z.string().uuid().nullish(),
    name: z.string().trim().min(1).max(200).nullish(),
    specialtyId: z.string().uuid().nullish(),
    scope: z.string().trim().min(1).max(20).nullish(),
    code: z.string().max(40).nullish(),
    priceCents: z.number().int().min(0).max(2147483647),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish(),
    durationMin: z.number().int().min(1).max(1440).nullish(),
    billingMode: z.enum(["treatment", "session"]).nullish(),
    priceDisclosure: z.enum(PRICE_DISCLOSURES).nullish(),
    evaluationServiceId: z.string().uuid().nullish(),
    leavesFinding: leavesFindingInput.nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

const patchInput = z
  .object({
    templateId: z.string().uuid().nullish(),
    name: z.string().trim().min(1).max(200).optional(),
    specialtyId: z.string().uuid().optional(),
    scope: z.string().trim().min(1).max(20).optional(),
    code: z.string().max(40).nullish(),
    priceCents: z.number().int().min(0).max(2147483647).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    durationMin: z.number().int().min(1).max(1440).nullish(),
    billingMode: z.enum(["treatment", "session"]).optional(),
    priceDisclosure: z.enum(PRICE_DISCLOSURES).optional(),
    evaluationServiceId: z.string().uuid().nullish(),
    leavesFinding: leavesFindingInput.nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

const templateItemShape = {
  templateId: z.string().uuid(),
  /** Nombre con el que la clínica lo ofrece; sin él, el de la biblioteca. */
  name: z.string().trim().min(1).max(200).nullish(),
  priceCents: z.number().int().min(0).max(2147483647),
  billingMode: z.enum(["treatment", "session"]).nullish(),
  durationMin: z.number().int().min(1).max(1440).nullish(),
}

/** «Agregar servicios»: de la biblioteca y propios, guardados en un solo acto. */
const batchInput = z
  .object({
    items: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("template"), ...templateItemShape }).strict(),
          z
            .object({
              kind: z.literal("custom"),
              name: z.string().trim().min(1).max(200),
              specialtyId: z.string().uuid(),
              scope: z.string().trim().min(1).max(20),
              priceCents: z.number().int().min(0).max(2147483647),
              billingMode: z.enum(["treatment", "session"]).nullish(),
              durationMin: z.number().int().min(1).max(1440).nullish(),
              leavesFinding: leavesFindingInput.nullish(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
    /** «¿Cómo dice el agente estos precios?»: una sola respuesta para todo lo que se agrega. */
    priceDisclosure: z.enum(PRICE_DISCLOSURES).optional(),
  })
  .strict()

/** «Cómo dice el precio» de varios servicios a la vez. */
const priceDisclosureInput = z
  .object({
    serviceIds: z.array(z.string().uuid()).min(1).max(PRICE_DISCLOSURE_BATCH),
    priceDisclosure: z.enum(PRICE_DISCLOSURES),
  })
  .strict()

const mostUsedQuery = z
  .object({
    perConcept: z.coerce.number().int().min(1).max(10).optional(),
  })
  .strict()

export function createServicesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los servicios"), 403)
    }
    const parsed = offersQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const page = await withOrgContext(deps.db, orgId, (tx) =>
        listServices(tx, orgId, {
          q: parsed.data.q,
          specialtyId: parsed.data.specialtyId,
          state: parsed.data.state,
          ids: parsed.data.ids,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
        }),
      )
      return c.json(page)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  // «Más usados»: conceptos generales (consulta, limpieza, resina…) resueltos
  // contra la biblioteca disponible, sin lo que la clínica ya incorporó.
  app.get("/most-used", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los servicios"), 403)
    }
    const parsed = mostUsedQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const data = await withOrgContext(deps.db, orgId, (tx) =>
        listMostUsedServices(tx, orgId, { perConcept: parsed.data.perConcept }),
      )
      return c.json({ data })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/templates", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los servicios"), 403)
    }
    const parsed = templatesQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const page = await withOrgContext(deps.db, orgId, (tx) =>
        listTemplates(tx, {
          q: parsed.data.q,
          specialty: parsed.data.specialty,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
        }),
      )
      return c.json(page)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/templates/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los servicios"), 403)
    }
    try {
      const data = await withOrgContext(deps.db, orgId, (tx) => getTemplate(tx, c.req.param("id")))
      return c.json({ data })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  // Un servicio por id, en cualquier estado: el que llega elegido aunque no esté en la primera página.
  app.get("/:id{[0-9a-fA-F-]+}", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los servicios"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getService(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/batch", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para administrar los servicios"),
        403,
      )
    }
    const parsed = batchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        quickAddServices(tx, orgId, userId, parsed.data.items, { priceDisclosure: parsed.data.priceDisclosure }),
      ),
    )
  })

  app.post("/price-disclosure", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para editar prestaciones"), 403)
    }
    const parsed = priceDisclosureInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setServicesPriceDisclosure(tx, orgId, userId, parsed.data)),
    )
  })

  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para crear prestaciones"), 403)
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createService(tx, orgId, userId, {
          templateId: parsed.data.templateId,
          name: parsed.data.name,
          specialtyId: parsed.data.specialtyId,
          scope: parsed.data.scope,
          code: parsed.data.code,
          priceCents: parsed.data.priceCents,
          currency: parsed.data.currency,
          durationMin: parsed.data.durationMin,
          billingMode: parsed.data.billingMode,
          priceDisclosure: parsed.data.priceDisclosure,
          evaluationServiceId: parsed.data.evaluationServiceId,
          leavesFinding: parsed.data.leavesFinding,
          isActive: parsed.data.isActive,
        }),
      ),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para editar prestaciones"), 403)
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateService(tx, orgId, userId, c.req.param("id"), {
          templateId: parsed.data.templateId,
          name: parsed.data.name,
          specialtyId: parsed.data.specialtyId,
          scope: parsed.data.scope,
          code: parsed.data.code,
          priceCents: parsed.data.priceCents,
          currency: parsed.data.currency,
          durationMin: parsed.data.durationMin,
          billingMode: parsed.data.billingMode,
          priceDisclosure: parsed.data.priceDisclosure,
          evaluationServiceId: parsed.data.evaluationServiceId,
          leavesFinding: parsed.data.leavesFinding,
          isActive: parsed.data.isActive,
        }),
      ),
    )
  })

  return app
}
