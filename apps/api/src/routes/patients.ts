import {
  BLOOD_GROUPS,
  DOC_TYPES,
  demographicsSchema,
  registrationAnswersSchema,
  registrationContactInputSchema,
  SURFACES,
  TREATMENT_PHASES,
} from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  addClinicalNote,
  addEncounterAddendum,
  addEncounterDiagnosis,
  addEncounterProcedure,
  addOdontogramEntries,
  addPlanItem,
  addPlanItemsBatch,
  type ClinicalAccessResource,
  createEncounter,
  createOdontogramAssessment,
  createTreatmentPlan,
  finalizeEncounter,
  findPatientDuplicates,
  getAnamnesisVersion,
  getEncounterClosing,
  getEncounterDetail,
  getLatestAnamnesis,
  getOdontogram,
  getPatient,
  getPatientDocument,
  getPatientHealth,
  getPatientSummary,
  getTimeline,
  getToothHistory,
  getTreatmentCoordination,
  getTreatmentPlanDetail,
  grantDataConsent,
  listAnamnesisVersions,
  listClinicalAccess,
  listClinicalNotes,
  listDataConsents,
  listEncounters,
  listOdontogramAssessments,
  listPatientDiagnoses,
  listPatientDocuments,
  listPatients,
  listPlanItems,
  listTreatmentPlans,
  PATIENT_AVATAR_MAX_BYTES,
  PATIENT_AVATAR_MIME_EXT,
  PATIENT_DOC_MAX_BYTES,
  PATIENT_DOC_MIME_EXT,
  registerPatient,
  registerPatientDocument,
  removePatientContact,
  requirePatient,
  reviewLegacyEntry,
  revokeDataConsent,
  ServiceError,
  savePatientHealth,
  scheduleFollowUpFromCoordination,
  setDiagnosisStatus,
  setPatientAvatar,
  setPatientContact,
  setPlanItemStatus,
  TIMELINE_TYPES,
  takeOverEncounter,
  updateEncounterDraft,
  updatePatient,
  updatePlanItem,
  updatePlanItemPlanning,
  voidEncounter,
  voidEncounterDiagnosis,
  voidEncounterProcedure,
  voidOdontogramEntry,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { traceClinicalRead } from "../lib/clinical-trace.js"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"
import { createPatientBudgetsRoute } from "./patient-budgets.js"
import { createPatientDocumentContextRoute } from "./patient-document-context.js"
import { createPatientFollowUpsRoute } from "./patient-follow-ups.js"
import { createPatientPaymentsRoute } from "./patient-payments.js"
import { createPatientPrescriptionsRoute } from "./patient-prescriptions.js"
import { createPatientResponsibilitiesRoute } from "./patient-responsibilities.js"
import { createPatientTreatmentsRoute } from "./patient-treatments.js"

const listQuery = z.object({
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const patientListQuery = listQuery.extend({
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  sex: z.enum(["M", "F"]).optional(),
  docType: z.enum(DOC_TYPES).optional(),
  sort: z.enum(["name", "-name", "created", "-created", "number", "-number"]).optional(),
})

const filiation = {
  ...demographicsSchema.partial().shape,
  registeredBranchId: z.uuid().nullish(),
}

const createInput = z.strictObject({
  submissionId: z.uuid(),
  answers: registrationAnswersSchema,
  formVersion: z.number().int().nonnegative().optional(),
  contacts: z.array(registrationContactInputSchema).max(50).optional(),
  registeredBranchId: z.uuid().optional(),
  contextContactId: z.uuid().optional(),
})

const patchInput = z.object({
  ...filiation,
  isActive: z.boolean().optional(),
  dataConsent: z.boolean().optional(),
  /** Recepción confirma el nombre separado tras la migración. */
  identityConfirmed: z.boolean().optional(),
})

const healthReviewState = z.enum(["unknown", "none", "recorded"])
const healthAllergy = z
  .object({
    id: z.uuid().optional(),
    substance: z.string().min(1).max(200),
    category: z.string().max(20).nullish(),
    reaction: z.string().max(2000).nullish(),
    /** Sin dato se guarda «desconocida». */
    severity: z.string().max(20).nullish(),
    kind: z.enum(["alergia", "intolerancia"]).nullish(),
    criticality: z.enum(["baja", "alta", "no_evaluable"]).nullish(),
    verification: z.enum(["no_confirmada", "confirmada", "descartada"]).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()
const familyHistoryItem = z
  .object({
    relationship: z.string().min(1).max(30),
    condition: z.string().min(1).max(200),
    cie10Code: z.string().max(10).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strict()
const healthCondition = z
  .object({
    id: z.uuid().optional(),
    name: z.string().min(1).max(200),
    cie10Code: z.string().max(10).nullish(),
    status: z.string().min(1).max(20),
    startDate: z.string().max(10).nullish(),
    endDate: z.string().max(10).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strict()
const healthMedication = z
  .object({
    id: z.uuid().optional(),
    name: z.string().min(1).max(200),
    genericName: z.string().max(200).nullish(),
    dose: z.string().max(200).nullish(),
    frequency: z.string().max(200).nullish(),
    startDate: z.string().max(10).nullish(),
    endDate: z.string().max(10).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strict()
// Guardado conjunto del agregado: colecciones completas con sus IDs, revisión
// optimista y entrevista opcional con versión esperada. El servicio valida el
// dominio (literales, fechas, consistencia none/recorded, claves excluidas).
const healthSaveInput = z
  .object({
    expectedRevision: z.number().int().min(0),
    reviewStatus: z
      .object({
        allergies: healthReviewState,
        conditions: healthReviewState,
        medications: healthReviewState,
      })
      .strict(),
    allergies: z.array(healthAllergy).max(200),
    conditions: z.array(healthCondition).max(200),
    medications: z.array(healthMedication).max(200),
    familyHistory: z.array(familyHistoryItem).max(50).optional(),
    asaClass: z.enum(["I", "II", "III", "IV", "V", "VI"]).nullish(),
    anamnesis: z
      .object({
        expectedVersion: z.number().int().min(0),
        answers: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
    dataConsent: z.literal(true).optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
  })
  .strict()

const noteInput = z.object({
  note: z.string().min(1).max(4000),
  diagnosisCode: z.string().max(10).nullish(),
  diagnosisType: z.string().max(20).nullish(),
  toothNumber: z.number().int().nullish(),
  encounterId: z.uuid().optional(),
})

// NTS 188: la validación normativa real la hace el servicio (dominio
// compartido, fail closed); aquí solo forma/tipos. Superficies canónicas del
// paquete (facial en anterior, buccal solo en posterior: el servicio rechaza
// el cruce). strict arriba: un `status` legado se rechaza, nunca se ignora.
const odontogramSurface = z.enum(SURFACES as unknown as [string, ...string[]])
const findingDetailsInput = z
  .object({
    variant: z.string().max(80).optional(),
    quality: z.enum(["good", "poor"]).optional(),
    grade: z.number().int().optional(),
    direction: z.enum(["clockwise", "counterclockwise"]).optional(),
    positions: z.array(z.string().max(30)).max(16).optional(),
    relatedTeeth: z.array(z.number().int()).max(52).optional(),
    abutmentTeeth: z.array(z.number().int()).max(52).optional(),
    clinicallyObserved: z.boolean().optional(),
    drawing: z
      .array(z.array(z.tuple([z.number(), z.number()])).min(1))
      .max(64)
      .optional(),
    specifications: z.string().max(2000).optional(),
    observations: z.string().max(2000).optional(),
  })
  .catchall(z.unknown())
const odontogramInput = z
  .object({
    toothNumber: z.number().int(),
    condition: z.string().trim().min(1).max(80),
    surfaces: z.array(odontogramSurface).max(8).default([]),
    details: findingDetailsInput.optional(),
    note: z.string().max(2000).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
    encounterId: z.uuid().optional(),
  })
  .strict()
const voidInput = z.object({ reason: z.string().trim().min(1).max(2000) })
const assessmentInput = z.object({
  purpose: z.enum(["initial", "new_findings", "completion", "reentry", "legal", "personal"]),
  specifications: z.string().trim().max(4000),
  observations: z.string().trim().max(4000),
  examinerName: z.string().trim().min(1).max(200),
  registrationNumber: z.string().trim().min(1).max(40),
  signature: z
    .array(
      z
        .array(z.tuple([z.number(), z.number()]))
        .min(2)
        .max(500),
    )
    .min(1)
    .max(50),
})
const timelineQuery = listQuery.extend({
  types: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.enum(TIMELINE_TYPES)))
    .optional(),
  toothNumber: z.coerce.number().int().optional(),
  documentCategory: z.enum(["radiografia", "foto_clinica"]).optional(),
  order: z.enum(["desc", "asc"]).optional(),
})
const encounterCreateInput = z.object({
  // El motivo es obligatorio al abrir la atención (decisión de diseño).
  reason: z.string().trim().min(1).max(2000),
  /** Cita que motiva la atención: hereda sede y profesional. */
  appointmentId: z.uuid().nullish(),
  branchId: z.uuid().nullish(),
  /** Profesional que atiende; por defecto quien abre la atención. */
  dentistUserId: z.string().nullish(),
  teeth: z.array(z.number().int()).max(52).optional(),
  planItemIds: z.array(z.uuid()).max(52).optional(),
})
const encounterPatchInput = z.object({
  branchId: z.uuid().nullish(),
  reason: z.string().max(2000).nullish(),
  evolution: z.string().max(10000).nullish(),
  indications: z.string().max(4000).nullish(),
  nextStep: z.string().max(2000).nullish(),
  nextAppointmentAt: z.iso.datetime({ offset: true }).nullish(),
  teeth: z.array(z.number().int()).max(52).optional(),
  examination: z
    .object({
      extraoral: z.record(z.string(), z.string().max(500)).nullish(),
      intraoral: z.record(z.string(), z.string().max(500)).nullish(),
      higieneOral: z.enum(["buena", "regular", "mala"]).nullish(),
    })
    .strict()
    .nullish(),
  presentIllness: z.string().max(4000).nullish(),
  illnessDuration: z.string().max(200).nullish(),
  /** Claves y rangos de @odentia/clinical (VITAL_SIGNS); el servicio valida. */
  vitals: z.record(z.string(), z.union([z.number(), z.string().max(10), z.null()])).nullish(),
  prognosis: z.string().max(2000).nullish(),
  auxiliaryExams: z.string().max(4000).nullish(),
})
const procedureInput = z
  .object({
    quantity: z.number().int().min(1).max(99).nullish(),
    serviceId: z.uuid().nullish(),
    toothNumber: z.number().int().nullish(),
    surfaces: z.array(z.string().min(1).max(20)).max(5).nullish(),
    quadrant: z.number().int().min(1).max(8).nullish(),
    arch: z.enum(["upper", "lower"]).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
    planItemId: z.uuid().nullish(),
    /** Acto libre (sin servicio ni tratamiento): descripción obligatoria. */
    description: z.string().trim().min(1).max(2000).nullish(),
    /** Hallazgo que trata un servicio directo; queda tratado al cerrar la atención. */
    odontogramEntryId: z.uuid().nullish(),
  })
  .strict()
  .refine((d) => !(d.serviceId && d.planItemId), {
    message: "Selecciona un servicio del catálogo o un tratamiento del presupuesto, no ambos",
  })
  .refine((d) => Boolean(d.serviceId) || Boolean(d.planItemId) || Boolean(d.description), {
    message: "Selecciona un servicio, un tratamiento o describe el acto libre",
  })
// El precio NUNCA se ingresa en evaluación/presupuesto: se congela desde la
// oferta (serviceId). title/priceCents/currency manuales se rechazan (400).
// La indicación pertenece a un plan y nace en una atención borrador (origen).
const planSiteFields = {
  toothNumber: z.number().int().nullish(),
  surfaces: z.array(z.string().min(1).max(20)).max(5).nullish(),
  quadrant: z.number().int().min(1).max(8).nullish(),
  arch: z.enum(["upper", "lower"]).nullish(),
}
const planCreateInput = z
  .object({
    serviceId: z.uuid(),
    planId: z.uuid(),
    sourceEncounterId: z.uuid(),
    optionGroupId: z.uuid().nullish(),
    odontogramEntryId: z.uuid().nullish(),
    isRecommended: z.boolean().optional(),
    detail: z.string().max(4000).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
    phase: z.enum(TREATMENT_PHASES).nullish(),
    plannedSessions: z.number().int().min(1).max(60).nullish(),
    ...planSiteFields,
  })
  .strict()
/** Planificación: fase, sesiones previstas y orden (sin acto clínico). */
const planPlanningInput = z
  .object({
    phase: z.enum(TREATMENT_PHASES).optional(),
    plannedSessions: z.number().int().min(1).max(60).optional(),
    move: z.enum(["up", "down"]).optional(),
  })
  .strict()
  .refine((d) => d.phase || d.plannedSessions || d.move, {
    message: "Indica la fase, las sesiones previstas o el movimiento",
  })
const planPatchInput = z
  .object({
    serviceId: z.uuid().optional(),
    detail: z.string().max(4000).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
    encounterId: z.uuid(),
    status: z
      .enum([
        "pendiente",
        "programado",
        "en_curso",
        "suspendido",
        "realizado",
        "cancelado",
        "reemplazado",
      ])
      .optional(),
    statusReason: z.string().trim().min(1).max(2000).optional(),
    ...planSiteFields,
  })
  .strict()
// Lote multi-pieza: un ítem por pieza en una sola transacción (ámbito tooth);
// sin campo precio (snapshot de la oferta). toothNumbers 1–52 FDI únicas.
const planBatchInput = z
  .object({
    serviceId: z.uuid(),
    planId: z.uuid(),
    sourceEncounterId: z.uuid(),
    toothNumbers: z.array(z.number().int()).min(1).max(52),
    detail: z.string().max(4000).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
  })
  .strict()
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()
const finalizeInput = z.object({ endedAt: z.iso.datetime({ offset: true }).nullish() }).strict()
const diagnosisInput = z
  .object({
    cie10Code: z.string().trim().min(1).max(10),
    diagnosisType: z.enum(["presuntivo", "definitivo", "repetido"]),
    toothNumber: z.number().int().nullish(),
    surfaces: z.array(z.string().min(1).max(20)).max(5).nullish(),
    note: z.string().max(2000).nullish(),
  })
  .strict()
const diagnosisStatusInput = z.object({ status: z.enum(["activo", "resuelto"]) }).strict()
const treatmentPlanCreateInput = z
  .object({ title: z.string().trim().min(1).max(200), originEncounterId: z.uuid() })
  .strict()
const jsonArrayField = z.preprocess((value) => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, z.array(z.unknown()))
const documentLinkInput = z.object({
  encounterId: z.uuid().optional(),
  planItemId: z.uuid().optional(),
  budgetId: z.uuid().optional(),
  encounterProcedureId: z.uuid().optional(),
  prescriptionId: z.uuid().optional(),
  followUpId: z.uuid().optional(),
  paymentId: z.uuid().optional(),
  toothNumbers: jsonArrayField.pipe(z.array(z.number().int()).max(52)).default([]),
  tags: jsonArrayField.pipe(z.array(z.string().min(1).max(200)).max(100)).default([]),
})

/** Subrutas con datos clínicos: exigen `clinical.read`/`.write`. */
const CLINICAL_SUBPATHS = [
  "/encounters",
  "/diagnoses",
  "/plan",
  "/treatments",
  "/prescriptions",
  "/follow-ups",
  "/documents",
  "/notes",
  "/health",
  "/anamnesis",
  "/odontogram",
  "/timeline",
  "/summary",
]

/** Subrutas de caja: exigen `finance.read`/`.write`. */
const FINANCE_SUBPATHS = ["/account", "/payments", "/budgets"]

/**
 * Coordinación del tratamiento: quien agenda ve qué falta reservar o decidir
 * sin leer la ficha. Exige `appointments.read`/`.write`, no `clinical.*`.
 */
const COORDINATION_SUBPATH = "/coordination"

/** Bitácora de consultas a la historia: la lee quien audita (`audit.read`). */
const ACCESS_LOG_SUBPATH = "/access-log"

/** Lecturas clínicas que dejan traza, por prefijo de subruta. */
const ACCESS_RESOURCE_BY_PREFIX: Array<[string, ClinicalAccessResource]> = [
  ["/summary", "resumen"],
  ["/health", "antecedentes"],
  ["/anamnesis", "antecedentes"],
  ["/odontogram", "odontograma"],
  ["/timeline", "historia"],
  ["/encounters", "atenciones"],
  ["/diagnoses", "diagnosticos"],
  ["/notes", "notas"],
  ["/plan", "plan"],
  ["/treatments", "tratamientos"],
  ["/follow-ups", "controles"],
  ["/prescriptions", "recetas"],
  ["/documents", "documentos"],
]

/** Mismo contrato que la reserva clínica del control (`patient-follow-ups.ts`). */
const coordinationScheduleInput = z.union([
  z.object({ appointmentId: z.uuid() }).strict(),
  z
    .object({
      appointment: z
        .object({
          branchId: z.uuid().optional(),
          dentistUserId: z.string().min(1),
          chairId: z.uuid(),
          serviceId: z.uuid().optional(),
          startsAt: z.iso.datetime({ offset: true }),
          endsAt: z.iso.datetime({ offset: true }).optional(),
          durationMin: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
])

export function createPatientsRoute(deps: CrmDeps) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    // `c.req.path` trae el prefijo de montaje (/api/patients...): el resto
    // tras el id clasifica el subdominio (filiación, clínica o caja).
    const remainder = c.req.path.match(/\/patients\/[^/]+(\/.*)?$/)?.[1] ?? ""
    const domain = remainder.startsWith(ACCESS_LOG_SUBPATH)
      ? "audit"
      : remainder.startsWith(COORDINATION_SUBPATH)
        ? "appointments"
        : CLINICAL_SUBPATHS.some((prefix) => remainder.startsWith(prefix))
          ? "clinical"
          : FINANCE_SUBPATHS.some((prefix) => remainder.startsWith(prefix))
            ? "finance"
            : "patients"
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    if (!canAccess(memberRole, `${domain}.${write ? "write" : "read"}`)) {
      return c.json(
        errorBody(
          c,
          "FORBIDDEN",
          write
            ? "No tienes permiso para modificar este recurso"
            : "No tienes permiso para ver este recurso",
        ),
        403,
      )
    }
    await next()
    // Toda lectura clínica atendida deja traza de quién consultó qué parte de
    // la ficha (`traceClinicalRead`: solo tras responder bien).
    if (domain !== "clinical" || write || c.res.status !== 200) return
    const patientId = c.req.path.match(/\/patients\/([0-9a-f-]{36})\//i)?.[1]
    const resource = ACCESS_RESOURCE_BY_PREFIX.find(([prefix]) => remainder.startsWith(prefix))?.[1]
    if (!patientId || !resource) return
    const { orgId, userId } = orgContextOf(c)
    await traceClinicalRead(deps.db, { orgId, userId, patientId, resource })
  })

  app.get("/:id/access-log", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listClinicalAccess(tx, orgId, c.req.param("id"))),
    )
  })

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = patientListQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listPatients(tx, orgId, parsed.data),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => {
        const { contextContactId, ...input } = parsed.data
        return registerPatient(
          tx,
          orgId,
          { kind: "internal", userId, contactId: contextContactId },
          input,
        )
      }),
    )
  })

  app.get("/duplicates", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        displayName: z.string().max(200).optional(),
        birthDate: z.iso.date().optional(),
        docType: z.string().max(20).optional(),
        docNumber: z.string().max(20).optional(),
        phone: z.string().max(50).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => findPatientDuplicates(tx, orgId, parsed.data)),
    )
  })

  app.put("/:id/contacts/:contactId", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = registrationContactInputSchema
      .omit({ contactId: true })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await setPatientContact(tx, orgId, userId, c.req.param("id"), {
          ...parsed.data,
          contactId: c.req.param("contactId"),
        })
        return { linked: true }
      }),
    )
  })

  app.delete("/:id/contacts/:contactId", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await removePatientContact(tx, orgId, userId, c.req.param("id"), c.req.param("contactId"))
        return { removed: true }
      }),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const clinical = canAccess(memberRole, "clinical.read")
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const full = await getPatient(tx, orgId, c.req.param("id"))
        // Sin `clinical.read` (recepción/caja): filiación y vínculos sin
        // registro de salud ni antecedentes/condiciones/medicación. Las
        // alergias activas solo se conservan con `clinical.alerts`.
        if (clinical) return full
        return {
          ...full,
          registration: null,
          activeAllergies: canAccess(memberRole, "clinical.alerts") ? full.activeAllergies : [],
          activeConditions: [],
          currentMedications: [],
        }
      }),
    )
    // La ficha completa entrega condiciones, medicación y registro de salud:
    // es una lectura de antecedentes y deja la misma traza que `/health`.
    if (clinical && response.status === 200) {
      const patientId = c.req.param("id")
      await traceClinicalRead(deps.db, { orgId, userId, patientId, resource: "antecedentes" })
    }
    return response
  })

  // --- Consentimiento de datos personales (Ley 29733) ---
  const dataConsentInput = z
    .object({
      purposes: z.array(z.enum(["atencion", "recordatorios", "comunicaciones"])).min(1),
      grantedByContactId: z.uuid(),
      channel: z.enum(["presencial", "formulario_publico", "portal"]).optional(),
    })
    .strict()
  app.get("/:id/data-consents", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listDataConsents(tx, orgId, c.req.param("id"))),
    )
  })
  app.post("/:id/data-consents", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = dataConsentInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        grantDataConsent(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.post("/:id/data-consents/:consentId/revoke", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = z
      .object({ reason: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        revokeDataConsent(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("consentId"),
          parsed.data,
        ),
      ),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updatePatient(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Coordinación del tratamiento (vista mínima para quien agenda) ---
  app.get("/:id/coordination", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getTreatmentCoordination(tx, orgId, c.req.param("id")),
      ),
    )
  })
  app.post("/:id/coordination/follow-ups/:followUpId/schedule", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = coordinationScheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        scheduleFollowUpFromCoordination(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("followUpId"),
          parsed.data,
        ),
      ),
    )
  })

  // --- Salud (agregado transaccional de antecedentes + entrevista) ---
  app.get("/:id/health", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPatientHealth(tx, orgId, c.req.param("id"))),
    )
  })
  app.put("/:id/health", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = healthSaveInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        savePatientHealth(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Anamnesis (lecturas históricas; la escritura va en PUT /health) ---
  app.get("/:id/anamnesis/history", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listAnamnesisVersions(tx, orgId, c.req.param("id"))),
    )
  })
  app.get("/:id/anamnesis/:versionId", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getAnamnesisVersion(tx, orgId, c.req.param("id"), c.req.param("versionId")),
      ),
    )
  })
  app.get("/:id/anamnesis", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, async () => {
      const row = await withOrgContext(deps.db, orgId, (tx) =>
        getLatestAnamnesis(tx, orgId, c.req.param("id")),
      )
      if (!row) throw new ServiceError("NOT_FOUND", 404, "Anamnesis no encontrada")
      return row
    })
  })

  // --- Evoluciones ---
  app.get("/:id/notes", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listClinicalNotes(tx, orgId, c.req.param("id"), parsed.data),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })
  app.post("/:id/notes", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = noteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addClinicalNote(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Odontograma ---
  app.get("/:id/odontogram", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getOdontogram(tx, orgId, c.req.param("id"))),
    )
  })
  // Historia de una pieza: hallazgos, diagnósticos, actos, controles y documentos.
  app.get("/:id/odontogram/teeth/:tooth/history", async (c) => {
    const { orgId } = orgContextOf(c)
    const tooth = Number(c.req.param("tooth"))
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getToothHistory(tx, orgId, c.req.param("id"), tooth)),
    )
  })
  app.post("/:id/odontogram/entries", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = odontogramInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addOdontogramEntries(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.post("/:id/odontogram/entries/:entryId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = voidInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidOdontogramEntry(
          tx,
          orgId,
          userId,
          c.req.param("entryId"),
          c.req.param("id"),
          parsed.data.reason,
        ),
      ),
    )
  })
  app.post("/:id/odontogram/entries/:entryId/review", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = voidInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reviewLegacyEntry(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("entryId"),
          parsed.data.reason,
        ),
      ),
    )
  })
  app.get("/:id/odontogram/assessments", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listOdontogramAssessments(tx, orgId, c.req.param("id")),
      ),
    )
  })
  app.post("/:id/odontogram/assessments", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = assessmentInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createOdontogramAssessment(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Documentos ---
  app.get("/:id/documents", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPatientDocuments(tx, orgId, c.req.param("id"))),
    )
  })
  app.post("/:id/documents", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const patientId = c.req.param("id")
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    const category = form?.get("category")
    const label = form?.get("label")
    const link = documentLinkInput.safeParse({
      encounterId: form?.get("encounterId") || undefined,
      planItemId: form?.get("planItemId") || undefined,
      budgetId: form?.get("budgetId") || undefined,
      encounterProcedureId: form?.get("encounterProcedureId") || undefined,
      prescriptionId: form?.get("prescriptionId") || undefined,
      followUpId: form?.get("followUpId") || undefined,
      paymentId: form?.get("paymentId") || undefined,
      toothNumbers: form?.get("toothNumbers") || undefined,
      tags: form?.get("tags") || undefined,
    })
    if (!link.success) return validationError(c, link.error.issues)
    if (!(file instanceof File))
      return c.json(errorBody(c, "VALIDATION", "Adjunta un archivo"), 400)
    if (typeof category !== "string" || typeof label !== "string" || !label.trim()) {
      return c.json(errorBody(c, "VALIDATION", "category y label son obligatorios"), 400)
    }
    const ext = PATIENT_DOC_MIME_EXT[file.type]
    if (!ext) return c.json(errorBody(c, "VALIDATION", "Solo se admiten JPG, PNG, WebP o PDF"), 400)
    if (file.size > PATIENT_DOC_MAX_BYTES) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB"), 400)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    return runService(c, 201, async () => {
      await withOrgContext(deps.db, orgId, (tx) => requirePatient(tx, orgId, patientId))
      const ref = await deps.storage.putPatientDocument({
        orgId,
        patientId,
        bytes,
        contentType: file.type,
        ext,
      })
      try {
        return await withOrgContext(deps.db, orgId, (tx) =>
          registerPatientDocument(tx, orgId, userId, patientId, {
            category,
            label: label.trim(),
            storageKey: ref.objectKey,
            contentType: file.type,
            sizeBytes: file.size,
            ...link.data,
          }),
        )
      } catch (e) {
        await deps.storage.deleteAttachment(ref.objectKey).catch(() => {})
        throw e
      }
    })
  })
  app.get("/:id/documents/:documentId/url", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, async () => {
      const doc = await withOrgContext(deps.db, orgId, (tx) =>
        getPatientDocument(tx, orgId, c.req.param("id"), c.req.param("documentId")),
      )
      const url = await deps.storage.attachmentUrl(doc.storageKey)
      return { url }
    })
  })

  app.post("/:id/avatar", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const patientId = c.req.param("id")
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File))
      return c.json(errorBody(c, "VALIDATION", "Adjunta una imagen"), 400)
    const ext = PATIENT_AVATAR_MIME_EXT[file.type]
    if (!ext) return c.json(errorBody(c, "VALIDATION", "Solo se admiten JPG, PNG o WebP"), 400)
    if (!file.size || file.size > PATIENT_AVATAR_MAX_BYTES)
      return c.json(errorBody(c, "VALIDATION", "La imagen debe pesar entre 1 byte y 2 MB"), 400)
    return runService(c, 201, async () => {
      await withOrgContext(deps.db, orgId, (tx) => requirePatient(tx, orgId, patientId))
      const ref = await deps.storage.putPatientAvatar({
        orgId,
        patientId,
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
        ext,
      })
      try {
        const avatarUrl = await deps.storage.attachmentUrl(ref.objectKey)
        const changed = await withOrgContext(deps.db, orgId, (tx) =>
          setPatientAvatar(tx, orgId, userId, patientId, ref.objectKey),
        )
        if (changed.previousStorageKey)
          await deps.storage.deleteAttachment(changed.previousStorageKey).catch(() => {})
        return { avatarUrl }
      } catch (e) {
        await deps.storage.deleteAttachment(ref.objectKey).catch(() => {})
        throw e
      }
    })
  })
  app.get("/:id/avatar-url", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, async () => {
      const row = await withOrgContext(deps.db, orgId, (tx) =>
        requirePatient(tx, orgId, c.req.param("id")),
      )
      if (!row.avatarStorageKey)
        throw new ServiceError("NO_AVATAR", 404, "El paciente no tiene avatar")
      return { url: await deps.storage.attachmentUrl(row.avatarStorageKey) }
    })
  })
  app.get("/:id/summary", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPatientSummary(tx, orgId, c.req.param("id"))),
    )
  })
  app.get("/:id/timeline", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = timelineQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return c.json(
        await withOrgContext(deps.db, orgId, (tx) =>
          getTimeline(tx, orgId, c.req.param("id"), parsed.data),
        ),
      )
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })
  app.post("/:id/encounters", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = encounterCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createEncounter(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.get("/:id/encounters", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = listQuery
      .extend({ status: z.enum(["borrador", "finalizada", "anulada"]).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listEncounters(tx, orgId, c.req.param("id"), parsed.data),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })
  app.get("/:id/encounters/:encounterId", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getEncounterDetail(tx, orgId, c.req.param("id"), c.req.param("encounterId")),
      ),
    )
  })
  app.patch("/:id/encounters/:encounterId", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = encounterPatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateEncounterDraft(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          parsed.data,
        ),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/procedures", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = procedureInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addEncounterProcedure(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          parsed.data,
        ),
      ),
    )
  })
  app.get("/:id/encounters/:encounterId/closing", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getEncounterClosing(tx, orgId, userId, c.req.param("id"), c.req.param("encounterId")),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/finalize", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const body = await c.req.json().catch(() => ({}))
    const parsed = finalizeInput.safeParse(body ?? {})
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        finalizeEncounter(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          parsed.data,
        ),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidEncounter(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          parsed.data,
        ),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/take-over", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        takeOverEncounter(tx, orgId, userId, c.req.param("id"), c.req.param("encounterId")),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/procedures/:procedureId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidEncounterProcedure(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          c.req.param("procedureId"),
          parsed.data,
        ),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/diagnoses", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = diagnosisInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addEncounterDiagnosis(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          parsed.data,
        ),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/diagnoses/:diagnosisId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidEncounterDiagnosis(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          c.req.param("diagnosisId"),
          parsed.data,
        ),
      ),
    )
  })
  // Lista de problemas del paciente: diagnósticos vigentes y resueltos.
  app.get("/:id/diagnoses", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({ status: z.enum(["activo", "resuelto"]).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listPatientDiagnoses(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.patch("/:id/diagnoses/:diagnosisId", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = diagnosisStatusInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setDiagnosisStatus(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("diagnosisId"),
          parsed.data.status,
        ),
      ),
    )
  })
  app.post("/:id/encounters/:encounterId/addenda", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = z
      .object({ text: z.string().trim().min(1).max(4000) })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addEncounterAddendum(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("encounterId"),
          parsed.data,
        ),
      ),
    )
  })
  app.get("/:id/plans", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listTreatmentPlans(tx, orgId, c.req.param("id"))),
    )
  })
  app.post("/:id/plans", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = treatmentPlanCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createTreatmentPlan(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.get("/:id/plans/:planId", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getTreatmentPlanDetail(tx, orgId, c.req.param("id"), c.req.param("planId")),
      ),
    )
  })
  app.get("/:id/plan", async (c) => {
    const { orgId } = orgContextOf(c)
    const planId = c.req.query("planId") || undefined
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPlanItems(tx, orgId, c.req.param("id"), planId)),
    )
  })
  app.post("/:id/plan/items", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = planCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addPlanItem(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.post("/:id/plan/items/batch", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = planBatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addPlanItemsBatch(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  app.patch("/:id/plan/items/:itemId/planning", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = planPlanningInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updatePlanItemPlanning(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("itemId"),
          parsed.data,
        ),
      ),
    )
  })
  app.patch("/:id/plan/items/:itemId", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = planPatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const { status, statusReason, ...patch } = parsed.data
        const args = [tx, orgId, userId, c.req.param("id"), c.req.param("itemId")] as const
        if (status && !Object.keys(patch).filter((k) => k !== "encounterId").length) {
          return setPlanItemStatus(...args, {
            status,
            statusReason,
            encounterId: patch.encounterId,
          })
        }
        const item = await updatePlanItem(...args, patch)
        return status
          ? setPlanItemStatus(...args, { status, statusReason, encounterId: patch.encounterId })
          : item
      }),
    )
  })
  app.route("/", createPatientBudgetsRoute(deps))
  app.route("/", createPatientDocumentContextRoute(deps))
  app.route("/", createPatientTreatmentsRoute(deps))
  app.route("/", createPatientFollowUpsRoute(deps))
  app.route("/", createPatientPrescriptionsRoute(deps))
  app.route("/", createPatientPaymentsRoute(deps))
  app.route("/", createPatientResponsibilitiesRoute(deps))

  return app
}
