import { withOrgContext } from "@odentia/db"
import {
  addFormAddendum,
  advanceClinicalOrder,
  archiveFormTemplate,
  archiveSpecialty,
  createClinicalOrder,
  createConsentDocument,
  createConsentTemplate,
  createFormResponse,
  createFormTemplate,
  createSpecialty,
  finalizeFormResponse,
  listClinicalOrders,
  listConsentDocuments,
  listConsentEvents,
  listConsentTemplates,
  listFormAddenda,
  listFormResponses,
  listFormTemplates,
  listProfessionalSpecialties,
  listServiceSpecialties,
  listSpecialties,
  listSpecialtyProfessionals,
  publishConsentTemplate,
  publishFormTemplate,
  revokeConsentDocument,
  setProfessionalSpecialties,
  setServiceSpecialties,
  signConsentDocument,
  updateConsentTemplate,
  updateFormResponseDraft,
  updateFormTemplate,
  updateSpecialty,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const uuid = z.string().uuid()
const text200 = z.string().trim().min(1).max(200)
const keySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/)
  .nullish()

const specialtyCreate = z
  .object({
    key: keySchema,
    name: text200,
    description: z.string().trim().max(2000).nullish(),
  })
  .strict()

const specialtyPatch = z
  .object({
    name: text200.optional(),
    description: z.string().trim().max(2000).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

const uuidList = (max: number) => z.array(uuid).max(max)

const fieldSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(50),
      label: z.string().min(1).max(200),
      type: z.enum([
        "texto",
        "texto_largo",
        "numero",
        "booleano",
        "opcion_unica",
        "opcion_multiple",
        "fecha",
        "firma",
      ]),
      required: z.boolean().optional(),
      options: z.array(z.string()).optional(),
      unit: z.string().max(20).nullish(),
      min: z.number().nullish(),
      max: z.number().nullish(),
      help: z.string().max(500).nullish(),
    })
    .strict(),
)

const formSchemaInput = z
  .object({
    sections: z
      .array(
        z
          .object({
            id: z.string().min(1).max(50),
            title: z.string().min(1).max(120),
            fields: z.array(fieldSchema).min(1).max(60),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()

const formTemplateCreate = z
  .object({
    key: keySchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    specialtyId: uuid.nullish(),
    schema: formSchemaInput,
  })
  .strict()

const formTemplatePatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullish(),
    specialtyId: uuid.nullish(),
    schema: formSchemaInput.optional(),
  })
  .strict()

function forbidden(c: Context, message: string) {
  return c.json(errorBody(c, "FORBIDDEN", message), 403)
}

function missingParam(c: Context, message: string) {
  return c.json(errorBody(c, "VALIDATION", message), 400)
}

/**
 * Catálogo de especialidades: no es dato clínico del paciente. Recepción y
 * agenda lo consultan con appointments.read; lo clínico sigue con clinical.read.
 */
function canReadCatalog(memberRole: string): boolean {
  return canAccess(memberRole, "clinical.read") || canAccess(memberRole, "appointments.read")
}

const responseCreate = z
  .object({
    templateId: uuid,
    patientId: uuid,
    encounterId: uuid.nullish(),
    professionalUserId: z.string().min(1).max(200).nullish(),
    answers: z.record(z.string(), z.unknown()).nullish(),
  })
  .strict()

const responsePatch = z
  .object({
    answers: z.record(z.string(), z.unknown()),
    professionalUserId: z.string().min(1).max(200).nullish(),
  })
  .strict()

const addendumInput = z.object({ text: z.string().trim().min(1).max(5000) }).strict()

const consentTemplateCreate = z
  .object({
    key: keySchema,
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(50).max(20000),
    specialtyId: uuid.nullish(),
  })
  .strict()

const consentTemplatePatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(50).max(20000).optional(),
    specialtyId: uuid.nullish(),
  })
  .strict()

const consentCreate = z
  .object({
    templateId: uuid,
    patientId: uuid,
    encounterId: uuid.nullish(),
    planItemId: uuid.nullish(),
    procedureRef: z.string().trim().max(500).nullish(),
  })
  .strict()

const consentSign = z
  .object({
    signerKind: z.enum(["paciente", "representante"]),
    signerName: z.string().trim().min(1).max(200),
    signerDoc: z.string().trim().max(40).nullish(),
    representativeRelation: z.string().trim().max(120).nullish(),
    signatureData: z.unknown(),
  })
  .strict()
  .refine((d) => d.signatureData !== null && d.signatureData !== undefined, {
    message: "La firma manuscrita es obligatoria",
  })

const consentRevoke = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()

const orderCreate = z
  .object({
    kind: z.enum(["laboratorio", "interconsulta"]),
    specialtyId: uuid.nullish(),
    patientId: uuid,
    encounterId: uuid.nullish(),
    recipient: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(5000).nullish(),
  })
  .strict()

const orderStatus = z
  .object({
    toStatus: z.enum(["en_proceso", "completado", "cancelado"]),
    resultText: z.string().trim().max(10000).nullish(),
  })
  .strict()

export function createClinicalFormsRoute(deps: CrmDeps) {
  const app = new Hono()

  // --- Especialidades ---
  app.get("/specialties", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canReadCatalog(memberRole)) return forbidden(c, "Sin acceso al catálogo")
    const q = c.req.query("q") ?? undefined
    const activeOnly = c.req.query("activeOnly") === "true"
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSpecialties(tx, orgId, { q, activeOnly })),
    )
  })

  app.post("/specialties", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración puede crear especialidades")
    }
    const parsed = specialtyCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createSpecialty(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/specialties/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración puede editar especialidades")
    }
    const parsed = specialtyPatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateSpecialty(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/specialties/:id/archive", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración puede archivar especialidades")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        archiveSpecialty(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  app.get("/specialties/:id/professionals", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canReadCatalog(memberRole)) return forbidden(c, "Sin acceso al catálogo")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listSpecialtyProfessionals(tx, orgId, c.req.param("id")),
      ),
    )
  })

  app.get("/professionals/:userId/specialties", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canReadCatalog(memberRole)) return forbidden(c, "Sin acceso al catálogo")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listProfessionalSpecialties(tx, orgId, c.req.param("userId")),
      ),
    )
  })

  app.put("/professionals/:userId/specialties", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración asigna especialidades")
    }
    const parsed = z.object({ specialtyIds: uuidList(20) }).strict().safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setProfessionalSpecialties(tx, orgId, userId, c.req.param("userId"), parsed.data.specialtyIds),
      ),
    )
  })

  app.get("/services/:serviceId/specialties", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canReadCatalog(memberRole)) return forbidden(c, "Sin acceso al catálogo")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listServiceSpecialties(tx, orgId, c.req.param("serviceId")),
      ),
    )
  })

  app.put("/services/:serviceId/specialties", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración vincula prestaciones")
    }
    const parsed = z.object({ specialtyIds: uuidList(10) }).strict().safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setServiceSpecialties(tx, orgId, userId, c.req.param("serviceId"), parsed.data.specialtyIds),
      ),
    )
  })

  // --- Plantillas de formulario ---
  app.get("/form-templates", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listFormTemplates(tx, orgId, {
          specialtyId: query.specialtyId,
          status: query.status,
          q: query.q,
        }),
      ),
    )
  })

  app.post("/form-templates", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración diseña formularios")
    }
    const parsed = formTemplateCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createFormTemplate(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/form-templates/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración edita formularios")
    }
    const parsed = formTemplatePatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateFormTemplate(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/form-templates/:id/publish", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración publica formularios")
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        publishFormTemplate(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  app.post("/form-templates/:id/archive", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración archiva formularios")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        archiveFormTemplate(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  // --- Capturas ---
  app.get("/form-responses", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    if (!query.patientId) return missingParam(c, "patientId es obligatorio")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listFormResponses(tx, orgId, {
          patientId: query.patientId!,
          encounterId: query.encounterId,
          templateId: query.templateId,
        }),
      ),
    )
  })

  app.post("/form-responses", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para registrar formularios")
    }
    const parsed = responseCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createFormResponse(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/form-responses/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para editar formularios")
    }
    const parsed = responsePatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateFormResponseDraft(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/form-responses/:id/finalize", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para finalizar formularios")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        finalizeFormResponse(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  app.get("/form-responses/:id/addenda", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listFormAddenda(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/form-responses/:id/addenda", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para agregar adendas")
    }
    const parsed = addendumInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addFormAddendum(tx, orgId, userId, c.req.param("id"), parsed.data.text),
      ),
    )
  })

  // --- Consentimientos ---
  app.get("/consent-templates", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listConsentTemplates(tx, orgId, {
          specialtyId: query.specialtyId,
          status: query.status,
          q: query.q,
        }),
      ),
    )
  })

  app.post("/consent-templates", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración diseña consentimientos")
    }
    const parsed = consentTemplateCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createConsentTemplate(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/consent-templates/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración edita consentimientos")
    }
    const parsed = consentTemplatePatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateConsentTemplate(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/consent-templates/:id/publish", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración publica consentimientos")
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        publishConsentTemplate(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  app.get("/consents", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    if (!query.patientId) return missingParam(c, "patientId es obligatorio")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listConsentDocuments(tx, orgId, { patientId: query.patientId!, status: query.status }),
      ),
    )
  })

  app.post("/consents", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para generar consentimientos")
    }
    const parsed = consentCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createConsentDocument(tx, orgId, userId, parsed.data)),
    )
  })

  app.post("/consents/:id/sign", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para firmar consentimientos")
    }
    const parsed = consentSign.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        signConsentDocument(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/consents/:id/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para revocar consentimientos")
    }
    const parsed = consentRevoke.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        revokeConsentDocument(tx, orgId, userId, c.req.param("id"), parsed.data.reason),
      ),
    )
  })

  app.get("/consents/:id/history", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listConsentEvents(tx, orgId, c.req.param("id"))),
    )
  })

  // --- Órdenes ---
  app.get("/orders", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listClinicalOrders(tx, orgId, {
          patientId: query.patientId,
          status: query.status,
          kind: query.kind,
          specialtyId: query.specialtyId,
        }),
      ),
    )
  })

  app.post("/orders", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para crear órdenes")
    }
    const parsed = orderCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createClinicalOrder(tx, orgId, userId, parsed.data)),
    )
  })

  app.post("/orders/:id/status", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para avanzar órdenes")
    }
    const parsed = orderStatus.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        advanceClinicalOrder(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          parsed.data.toStatus,
          parsed.data.resultText,
        ),
      ),
    )
  })

  return app
}
