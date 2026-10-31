import { withOrgContext } from "@odentia/db"
import {
  addFormAddendum,
  advanceClinicalOrder,
  archiveConsentTemplate,
  archiveFormTemplate,
  archiveSpecialty,
  cancelClinicalOrder,
  cancelConsentDocument,
  clinicalOrderPatientId,
  confirmLinkSignedConsent,
  consentDocumentPatientId,
  markConsentSentByLink,
  sendPersonalLink,
  createClinicalOrder,
  createConsentDocument,
  createConsentTemplate,
  createFormResponse,
  createFormTemplate,
  createSpecialty,
  createSuggestedConsentTemplates,
  discardFormResponse,
  finalizeFormResponse,
  formResponsePatientId,
  generateConsentPdf as generateConsentPdfService,
  getConsentPrint,
  getEncounterConsentNeeds,
  getOrderPrint,
  getProfessionalProfile,
  listClinicalOrders,
  listConsentDocuments,
  listConsentEvents,
  listConsentTemplateServices,
  listConsentTemplates,
  listFormAddenda,
  listFormResponses,
  listFormTemplates,
  listProfessionalProfiles,
  listProfessionalSpecialties,
  listSpecialties,
  listSpecialtiesOverview,
  listSpecialtyProfessionals,
  prepareEncounterConsents,
  publishConsentTemplate,
  publishFormTemplate,
  revokeConsentDocument,
  setConsentTemplateServices,
  setProfessionalProfile,
  setProfessionalSpecialties,
  setSpecialtyProfessionals,
  signConsentDocument,
  updateConsentTemplate,
  updateFormResponseDraft,
  updateFormTemplate,
  updateSpecialty,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { traceClinicalRead } from "../lib/clinical-trace.js"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const uuid = z.string().uuid()
const keySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/)
  .nullish()

/** El nombre de una especialidad, con la voz de Configuración › Especialidades. */
const specialtyName = z
  .string()
  .trim()
  .min(1, "Escribe el nombre de la especialidad")
  .max(120, "El nombre de la especialidad admite hasta 120 caracteres")
const specialtyDescription = z
  .string()
  .trim()
  .max(2000, "La descripción admite hasta 2000 caracteres")
  .nullish()

const specialtyCreate = z
  .object({
    key: keySchema,
    name: specialtyName,
    description: specialtyDescription,
  })
  .strict()

const specialtyPatch = z
  .object({
    name: specialtyName.optional(),
    description: specialtyDescription,
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
        "pieza",
        "escala",
        "adjunto",
      ]),
      required: z.boolean().optional(),
      options: z.array(z.string()).max(50, "Una pregunta admite hasta 50 opciones").optional(),
      unit: z.string().max(20).nullish(),
      min: z.number().nullish(),
      max: z.number().nullish(),
      help: z.string().max(500).nullish(),
      showIf: z
        .object({ field: z.string().min(1).max(50), equals: z.union([z.string(), z.boolean()]) })
        .strict()
        .nullish(),
      // Lo que responde el paciente en el portal y pasa a sus antecedentes (`FIELD_DEFINITIONS`).
      definition: z.enum(["AllergyIntolerance.code"]).nullish(),
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
            fields: z
              .array(fieldSchema)
              .min(1, "Cada sección necesita al menos un campo")
              .max(60, "Una sección admite hasta 60 campos"),
          })
          .strict(),
      )
      .min(1, "Agrega al menos una sección")
      .max(30, "El formulario admite hasta 30 secciones"),
  })
  .strict()

const formTemplateCreate = z
  .object({
    key: keySchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    specialtyId: uuid.nullish(),
    respondent: z.enum(["staff", "portal"]).optional(),
    schema: formSchemaInput,
  })
  .strict()

const formTemplatePatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullish(),
    specialtyId: uuid.nullish(),
    respondent: z.enum(["staff", "portal"]).optional(),
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

const addendumInput = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Escribe la adenda.")
      .max(5000, "La adenda admite hasta 5000 caracteres."),
  })
  .strict()

/** Una lista del consentimiento (una línea por elemento), con su nombre en cada mensaje. */
const consentList = (one: string, many: string, a: "un" | "una") =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1, `Indica al menos ${a} ${one}`)
        .max(500, `Cada ${one} admite hasta 500 caracteres`),
    )
    .min(1, `Indica al menos ${a} ${one}`)
    .max(20, `Escribe como mucho 20 ${many}`)

const consentSections = z.object({
  procedure: z.string().trim().min(10, "Describe el procedimiento (al menos 10 caracteres)").max(4000),
  benefits: consentList("beneficio", "beneficios", "un"),
  risks: consentList("riesgo", "riesgos", "un"),
  alternatives: consentList("alternativa", "alternativas", "una"),
  consequences: z.string().trim().min(10, "Describe las consecuencias de no tratarse (al menos 10 caracteres)").max(4000),
  notes: z.string().trim().max(4000).nullish(),
})

const consentTemplateCreate = z
  .object({
    key: keySchema,
    title: z.string().trim().min(1).max(200),
    sections: consentSections.optional(),
    body: z.string().trim().min(50).max(20000).optional(),
    specialtyId: uuid.nullish(),
  })
  .strict()
  .refine((d) => d.sections || d.body, { message: "Completa las secciones del consentimiento" })

const consentTemplatePatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    sections: consentSections.optional(),
    body: z.string().trim().min(50).max(20000).optional(),
    specialtyId: uuid.nullish(),
  })
  .strict()

const consentCreate = z
  .object({
    templateId: z.uuid({ message: "Elige una plantilla publicada" }),
    patientId: uuid,
    encounterId: uuid.nullish(),
    planItemId: uuid.nullish(),
    procedureRef: z.string().trim().max(500).nullish(),
    diagnosisCode: z.string().trim().max(10).nullish(),
    diagnosisSystem: z.string().max(20).nullish(),
  })
  .strict()

const consentSign = z
  .object({
    signerKind: z.enum(["paciente", "representante"]),
    signerContactId: z.uuid({ message: "Elige a la persona que firma" }),
    signerDoc: z.string().trim().max(40).nullish(),
    representativeRelation: z.string().trim().max(120).nullish(),
    // En la clínica, el trazo de la persona; en papel, la foto de la hoja.
    signatureData: z.unknown().optional(),
    comprehensionConfirmed: z.literal(true, {
      message: "La persona firmante debe confirmar que comprendió la información",
    }),
    // El profesional confirma con su perfil: el trazo es opcional.
    professionalSignature: z.unknown().optional(),
    witness: z
      .object({ name: z.string().trim().min(1).max(200), doc: z.string().trim().max(40).nullish() })
      .nullish(),
    informedAt: z.iso.datetime({ offset: true }).nullish(),
    method: z.enum(["clinica", "papel"]).optional(),
    paperDocumentId: uuid.nullish(),
  })
  .strict()
  .refine(
    (d) => d.method === "papel" || (d.signatureData !== null && d.signatureData !== undefined),
    { message: "La firma manuscrita es obligatoria", path: ["signatureData"] },
  )
  .refine((d) => d.method !== "papel" || Boolean(d.paperDocumentId), {
    message: "Sube la foto de la hoja firmada",
    path: ["paperDocumentId"],
  })

const consentNeedsQuery = z.object({ patientId: uuid, encounterId: uuid })

const consentPrepare = z
  .object({
    patientId: uuid,
    encounterId: uuid,
    templateKeys: z.array(z.string().trim().min(2).max(40)).max(20).optional(),
  })
  .strict()

const consentTemplateServicesInput = z
  .object({ serviceIds: z.array(uuid).max(100, "Elige como mucho 100 servicios") })
  .strict()

const consentRevoke = z
  .object({
    reason: z.string().trim().min(1, "La revocación necesita un motivo").max(2000),
    revokerContactId: z.uuid({ message: "Indica quién revoca" }),
    signatureData: z.unknown(),
  })
  .strict()

const consentCancel = z
  .object({ reason: z.string().trim().min(1, "Escribe el motivo").max(2000) })
  .strict()

const orderCreate = z
  .object({
    kind: z.enum(["imagen", "laboratorio", "interconsulta"]),
    specialtyId: uuid.nullish(),
    patientId: uuid,
    encounterId: uuid.nullish(),
    recipient: z.string().trim().max(200).nullish(),
    recipientUserId: z.string().min(1).max(200).nullish(),
    title: z.string().trim().min(1, "Escribe qué se pide").max(200),
    detail: z.string().trim().max(5000).nullish(),
    diagnosisCode: z.string().trim().max(10).nullish(),
    diagnosisSystem: z.string().max(20).nullish(),
  })
  .strict()
  .refine((d) => Boolean(d.recipient?.trim() || d.recipientUserId), {
    message: "Indica para quién es la orden",
    path: ["recipient"],
  })

const orderStatus = z
  .object({
    toStatus: z.enum(["en_proceso", "completado", "cancelado"]),
    resultText: z.string().trim().max(10000).nullish(),
    // El resultado subido a la propia orden (un documento de la persona).
    resultDocumentId: uuid.nullish(),
    // Cancelar pide motivo.
    reason: z.string().trim().max(2000).nullish(),
  })
  .strict()
  .refine((d) => d.toStatus !== "cancelado" || Boolean(d.reason?.trim()), {
    message: "Cancelar la orden pide el motivo",
    path: ["reason"],
  })

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

  // Configuración › Especialidades: quién atiende cada una y cuántos servicios tiene.
  app.get("/specialties/overview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canReadCatalog(memberRole) && !canAccess(memberRole, "settings.read")) {
      return forbidden(c, "Sin acceso a las especialidades")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSpecialtiesOverview(tx, orgId)),
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

  // «Elegir quién atiende»: la lista completa de una especialidad, de una vez.
  app.put("/specialties/:id/professionals", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración asigna especialidades")
    }
    const parsed = z
      .object({
        userIds: z
          .array(z.string().min(1).max(200))
          .max(100, "Marca como mucho 100 personas"),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setSpecialtyProfessionals(tx, orgId, userId, c.req.param("id"), parsed.data.userIds),
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

  // --- Perfil profesional (firma de atenciones, actas, recetas y consentimientos) ---
  const profileInput = z
    .object({
      signatureName: z.string().max(200, "El nombre de firma admite hasta 200 caracteres").nullish(),
      professionalTitle: z
        .string()
        .trim()
        .min(1, "El título profesional es obligatorio")
        .max(120, "El título profesional admite hasta 120 caracteres")
        .optional(),
      registrationBody: z
        .string()
        .trim()
        .min(1, "El colegio profesional es obligatorio")
        .max(40, "El colegio profesional admite hasta 40 caracteres")
        .optional(),
      registrationNumber: z.string().max(20, "La colegiatura admite hasta 20 caracteres").nullish(),
      specialtyRegistration: z.string().max(40, "El registro de especialista admite hasta 40 caracteres").nullish(),
    })
    .strict()

  app.get("/professionals/profiles", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canReadCatalog(memberRole) && !canAccess(memberRole, "settings.read")) {
      return forbidden(c, "Sin acceso a los profesionales")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listProfessionalProfiles(tx, orgId)),
    )
  })

  app.get("/professionals/:userId/profile", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const target = c.req.param("userId") === "me" ? userId : c.req.param("userId")
    if (target !== userId && !canReadCatalog(memberRole) && !canAccess(memberRole, "settings.read")) {
      return forbidden(c, "Sin acceso a los profesionales")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getProfessionalProfile(tx, orgId, target)),
    )
  })

  // Cada profesional mantiene su propia colegiatura; administración, la de todos.
  app.put("/professionals/:userId/profile", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const target = c.req.param("userId") === "me" ? userId : c.req.param("userId")
    if (target !== userId && !canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración edita el perfil de otro profesional")
    }
    const parsed = profileInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setProfessionalProfile(tx, orgId, userId, target, parsed.data),
      ),
    )
  })

  // --- Plantillas de formulario ---
  app.get("/form-templates", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listFormTemplates(tx, orgId, {
          specialtyId: query.specialtyId,
          status: query.status,
          q: query.q,
          // Desde la atención: primero los de las especialidades de quien atiende.
          forUserId: query.forUser === "me" ? userId : query.forUser || undefined,
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
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    if (!query.patientId) return missingParam(c, "patientId es obligatorio")
    const patientId = query.patientId
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listFormResponses(tx, orgId, {
          patientId,
          encounterId: query.encounterId,
          templateId: query.templateId,
        }),
      ),
    )
    if (response.status === 200)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "formularios" })
    return response
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

  app.post("/form-responses/:id/discard", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para descartar formularios")
    }
    const parsed = z
      .object({
        reason: z
          .string()
          .trim()
          .min(1, "Indica el motivo del descarte.")
          .max(2000, "El motivo admite hasta 2000 caracteres."),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        discardFormResponse(tx, orgId, userId, c.req.param("id"), parsed.data.reason),
      ),
    )
  })

  app.get("/form-responses/:id/addenda", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    let patientId: string | null = null
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        patientId = await formResponsePatientId(tx, orgId, c.req.param("id"))
        return listFormAddenda(tx, orgId, c.req.param("id"))
      }),
    )
    if (response.status === 200 && patientId)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "formularios" })
    return response
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

  app.post("/consent-templates/:id/archive", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración archiva consentimientos")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        archiveConsentTemplate(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  app.post("/consent-templates/suggested", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración diseña consentimientos")
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createSuggestedConsentTemplates(tx, orgId, userId)),
    )
  })

  // «Se pide para»: los servicios que piden cada plantilla (por su clave).
  app.get("/consent-template-services", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read") && !canAccess(memberRole, "settings.read")) {
      return forbidden(c, "Sin acceso a los consentimientos")
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listConsentTemplateServices(tx, orgId)),
    )
  })

  app.put("/consent-templates/:id/services", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return forbidden(c, "Solo administración decide para qué se pide un consentimiento")
    }
    const parsed = consentTemplateServicesInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConsentTemplateServices(tx, orgId, userId, c.req.param("id"), parsed.data.serviceIds),
      ),
    )
  })

  // Lo que pide la atención: firmado, pendiente, sin preparar o sin publicar.
  app.get("/consent-needs", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const parsed = consentNeedsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { patientId, encounterId } = parsed.data
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getEncounterConsentNeeds(tx, orgId, patientId, encounterId),
      ),
    )
    if (response.status === 200)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "consentimientos" })
    return response
  })

  // «Preparar»: genera los que faltan, llenos con lo de la atención.
  app.post("/consent-needs/prepare", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para preparar consentimientos")
    }
    const parsed = consentPrepare.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { patientId, encounterId, templateKeys } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        prepareEncounterConsents(tx, orgId, userId, patientId, encounterId, templateKeys),
      ),
    )
  })

  const generateConsentPdf = (orgId: string, userId: string, consentId: string) =>
    generateConsentPdfService({
      run: (fn) => withOrgContext(deps.db, orgId, fn),
      storage: deps.storage,
      orgId,
      userId,
      consentId,
    })

  app.get("/consents", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    if (!query.patientId) return missingParam(c, "patientId es obligatorio")
    const patientId = query.patientId
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listConsentDocuments(tx, orgId, { patientId, status: query.status }),
      ),
    )
    if (response.status === 200)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "consentimientos" })
    return response
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
    return runService(c, 200, async () => {
      const signed = await withOrgContext(deps.db, orgId, (tx) =>
        signConsentDocument(tx, orgId, userId, c.req.param("id"), parsed.data),
      )
      // El PDF se genera tras la firma; si falla, la firma queda registrada y
      // el PDF se reintenta con POST …/pdf (no se repite la firma).
      try {
        return await generateConsentPdf(orgId, userId, signed.id)
      } catch (e) {
        console.error("consent pdf", e)
        return signed
      }
    })
  })

  // Antes de llegar (decisión 3): se envía a firmar por «Su enlace» de la
  // persona (o de su representante legal), con la regla de envío de siempre.
  app.post("/consents/:id/send-link", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para enviar consentimientos")
    }
    const parsed = z.strictObject({ requestId: z.uuid().optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const consent = await markConsentSentByLink(tx, orgId, userId, c.req.param("id"))
        return sendPersonalLink(
          tx,
          orgId,
          userId,
          { patientId: consent.patientId, requestId: parsed.data.requestId ?? null },
          { secretsKey: deps.secretsKey },
        )
      }),
    )
  })

  // En la cita, el profesional confirma lo que la persona firmó en su enlace.
  app.post("/consents/:id/confirm", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para firmar consentimientos")
    }
    return runService(c, 200, async () => {
      const signed = await withOrgContext(deps.db, orgId, (tx) => confirmLinkSignedConsent(tx, orgId, userId, c.req.param("id")))
      // Como al firmar en la clínica: el PDF se genera después y se reintenta aparte si falla.
      try {
        return await generateConsentPdf(orgId, userId, signed.id)
      } catch (e) {
        console.error("consent pdf", e)
        return signed
      }
    })
  })

  app.post("/consents/:id/pdf", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para generar el PDF del consentimiento")
    }
    return runService(c, 200, () => generateConsentPdf(orgId, userId, c.req.param("id")))
  })

  app.get("/consents/:id/print", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    let patientId: string | null = null
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const data = await getConsentPrint(tx, orgId, c.req.param("id"))
        patientId = data.document.patientId
        return data
      }),
    )
    if (response.status === 200 && patientId)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "consentimientos" })
    return response
  })

  app.post("/consents/:id/cancel", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return forbidden(c, "Sin permiso para anular consentimientos")
    }
    const parsed = consentCancel.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        cancelConsentDocument(tx, orgId, userId, c.req.param("id"), parsed.data.reason),
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
    return runService(c, 200, async () => {
      const revoked = await withOrgContext(deps.db, orgId, (tx) =>
        revokeConsentDocument(tx, orgId, userId, c.req.param("id"), parsed.data),
      )
      // Como al firmar: el PDF de la revocación se genera después y se
      // reintenta con POST …/pdf si falla (no se repite la revocación).
      try {
        return await generateConsentPdf(orgId, userId, revoked.id)
      } catch (e) {
        console.error("consent revoke pdf", e)
        return revoked
      }
    })
  })

  app.get("/consents/:id/history", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    let patientId: string | null = null
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        patientId = await consentDocumentPatientId(tx, orgId, c.req.param("id"))
        return listConsentEvents(tx, orgId, c.req.param("id"))
      }),
    )
    if (response.status === 200 && patientId)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "consentimientos" })
    return response
  })

  // --- Órdenes ---
  app.get("/orders", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    const query = c.req.query()
    // Sin paciente es una lista de trabajo: deja traza en cada paciente cuyas
    // órdenes se sirvieron, no solo en el filtrado.
    const served = new Set<string>()
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const orders = await listClinicalOrders(tx, orgId, {
          patientId: query.patientId,
          status: query.status,
          kind: query.kind,
          specialtyId: query.specialtyId,
          encounterId: query.encounterId,
        })
        for (const order of orders) served.add(order.patientId)
        if (query.patientId) served.add(query.patientId)
        return orders
      }),
    )
    if (response.status === 200) {
      for (const patientId of served)
        await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "ordenes" })
    }
    return response
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
    const { toStatus, resultText, resultDocumentId, reason } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        toStatus === "cancelado"
          ? cancelClinicalOrder(tx, orgId, userId, c.req.param("id"), reason ?? "")
          : advanceClinicalOrder(tx, orgId, userId, c.req.param("id"), toStatus, resultText, {
              resultDocumentId,
            }),
      ),
    )
  })

  // La hoja de la orden para imprimir: qué se pide, para quién y quién la pide.
  app.get("/orders/:id/print", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidden(c, "Sin acceso clínico")
    let patientId: string | null = null
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        patientId = await clinicalOrderPatientId(tx, orgId, c.req.param("id"))
        return getOrderPrint(tx, orgId, c.req.param("id"))
      }),
    )
    if (response.status === 200 && patientId)
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "ordenes" })
    return response
  })

  return app
}
