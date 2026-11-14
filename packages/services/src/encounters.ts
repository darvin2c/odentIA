import { canAttend } from "@odentia/auth/permissions"
import {
  budgetStateText,
  isLeftOut,
  isLocalAnestheticName,
  parseVitals,
  sumByCurrency,
  vitalsErrors,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import {
  appointmentPlanItem,
  clinicalFollowUp,
  clinicalNote,
  diagnosisCatalog,
  encounter,
  encounterDiagnosis,
  encounterPlanItem,
  encounterProcedure,
  encounterSite,
  patient,
  patientCharge,
  prescription,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import {
  clinicalOrder,
  consentDocument,
  consentEvent,
  medicalLeave,
} from "@odentia/db/schema/clinical-forms"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm"
import { acceptedBudgetLines } from "./agreed-lines.js"
import {
  appointmentSessionsOf,
  type FreedAppointment,
  freedAppointmentsOf,
  markArrivedOnAttend,
  notifyAppointmentChanged,
  setAppointmentStatus,
} from "./appointments.js"
import { zonedTimeToUtc } from "./availability.js"
import {
  type AssembledBudget,
  assembleEncounterBudget,
  readBillingModes,
  removeBudgetItems,
} from "./budgets.js"
import {
  type HealthGap,
  healthGapsOf,
  listEncounterDocuments,
  type PatientDocumentWithContext,
} from "./clinical.js"
import {
  type ConsentNeed,
  cancelDerivationTask,
  discardVoidedEncounterForms,
  getEncounterConsentNeeds,
  listOpenEncounterForms,
} from "./clinical-forms.js"
import {
  type ClosingResolvable,
  resolvableDiagnosesOf,
  resolveDiagnosesOnSign,
} from "./closing-diagnoses.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { DROPPED_PLAN_ITEM_STATUSES, resolveOptionalDiagnosisCode } from "./diagnosis-codes.js"
import { assertAttending } from "./encounter-attending.js"
import { removableFromEncounter } from "./encounter-plan-remove.js"
import { type EncounterVisit, encounterVisitOf } from "./encounter-visit.js"
import {
  checkEncounterVoidBudgets,
  type EncounterVoidPreview,
  encounterVoidBudgets,
  settleEncounterVoidBudgets,
} from "./encounter-void-budgets.js"
import {
  branchNotFound,
  invalidField,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import {
  applyFinishingControlChanges,
  createFinishControls,
  type FinishingControl,
  type FinishingControlChange,
  finishingControlsOf,
  undoFinishControls,
} from "./finish-controls.js"
import { createFollowUp, repeatFollowUp } from "./follow-ups.js"
import { treatmentConsentStates } from "./consent-state.js"
import { findOrgLocale, orgClinicalProfile } from "./locale.js"
import { requirePatient } from "./patients.js"
import { ADVANCE_KEY, type WholeReturnedCharge, wholeReturnedCharges } from "./charge-returns.js"
import { createCharge } from "./payments.js"
import {
  addPlanItem,
  createTreatmentPlan,
  lockPlanItemForExecution,
  revisionsOf,
  setPlanItemStatus,
  surfaceLimits,
  undoRevisionsOf,
  updatePlanItemPlanning,
} from "./plan.js"
import { assertExecutableCodings, resolveServiceCodings } from "./procedure-codings.js"
import {
  type ProductParts,
  type ProductSite,
  type SiteColumns,
  type SiteFields,
  siteInputOf,
  withSite,
} from "./product-hooks.js"
import { productHooks } from "./products.js"
import { nextSessionGapOf } from "./session-gap.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { countConsultationAction } from "./saas-actions.js"
import { requireServiceForIndication } from "./service-catalog.js"
import {
  type ClosingMaterials,
  closingMaterialsOf,
  type DiscountedMaterials,
  discountEncounterMaterials,
} from "./service-materials.js"
import {
  canBookAnother,
  controlWindowOpenSql,
  controlWindowStart,
  dayKeyIn,
  goesBeforeSql,
  LIVE_APPOINTMENT_STATUSES,
  pairsWithAccepted,
  planItemSql,
  sessionCountsOf,
  sessionsDoneSql,
  TO_SCHEDULE_STATUSES,
} from "./to-schedule.js"

export type EncounterRow = typeof encounter.$inferSelect
export type EncounterProcedureRow = typeof encounterProcedure.$inferSelect & SiteFields
export type EncounterDiagnosisRow = typeof encounterDiagnosis.$inferSelect & SiteFields
export type EncounterNoteRow = typeof clinicalNote.$inferSelect & SiteFields
/** Documento con vínculos, piezas y etiquetas de su revisión vigente. */
export type EncounterDocumentRow = PatientDocumentWithContext
export type EncounterPlannedItemRow = typeof treatmentPlanItem.$inferSelect & SiteFields
/**
 * Un tratamiento de la atención con sus sesiones hechas (las atenciones no
 * anuladas con un procedimiento suyo, esta incluida: la regla de
 * `sessionsDoneSql`) y si quien lleva el borrador puede quitarlo
 * (`removableFromEncounter`: indicado aquí, sin respuesta y sin entregar).
 */
export type EncounterItem = EncounterPlannedItemRow & { sessionsDone: number; removable: boolean }

export interface CreateEncounterInput {
  /**
   * Motivo de la visita (hasta 2000 caracteres). No se pide al abrir: desde
   * una cita toma el motivo escrito en ella; si no, queda vacío y se exige al
   * cerrar (ADR 0032 y 0098).
   */
  reason?: string | null
  /**
   * Cita que motiva la atención (mismo paciente). Hereda la sede; al cerrar la
   * atención la cita pasa a «atendida». Sin ella, la atención se une a la cita
   * de hoy que siga en pie; con un borrador del mismo día sin cita, ese
   * borrador se une a la cita en vez de abrir otro.
   */
  appointmentId?: string | null
  branchId?: string | null
  /** Profesional que atiende; por defecto quien abre. Debe tener escritura clínica. */
  professionalUserId?: string | null
  teeth?: number[]
  /**
   * Tratamientos del presupuesto para vincular a la atención. Deben estar
   * aceptados (decision aceptado), pendientes o programados, del mismo
   * paciente/org y con presupuesto vigente. NO se marcan realizados al crear.
   */
  planItemIds?: string[]
}

export interface UpdateEncounterDraftPatch {
  branchId?: string | null
  reason?: string | null
  evolution?: string | null
  indications?: string | null
  /** Reemplaza el set completo de piezas (vacío = sin piezas). */
  teeth?: number[]
  /** Examen físico de la atención, con la forma del producto (`ProductExamination`); null lo limpia. */
  examination?: Record<string, unknown> | null
  /** Enfermedad actual: relato y tiempo de enfermedad. */
  presentIllness?: string | null
  illnessDuration?: string | null
  /** Signos vitales (claves de @odentia/clinical); null los limpia. */
  vitals?: Record<string, unknown> | null
  prognosis?: string | null
  /**
   * Lo que el editor cree guardado en cada texto que cambia, para no pisar lo
   * que otra pestaña o persona guardó mientras tanto (`STALE_DRAFT`). Sin él,
   * se guarda como antes.
   */
  base?: Partial<Record<EncounterTextField, string | null>>
}

/** Los textos del borrador que el editor escribe y se cuidan de otra pestaña. */
export const ENCOUNTER_TEXT_FIELDS = ["reason", "evolution", "indications", "presentIllness", "illnessDuration", "prognosis"] as const
export type EncounterTextField = (typeof ENCOUNTER_TEXT_FIELDS)[number]

/** Cómo se llama cada texto en la pantalla: así el aviso dice cuál cambió. */
const ENCOUNTER_TEXT_LABELS: Record<EncounterTextField, string> = {
  reason: "Motivo",
  evolution: "Evolución",
  indications: "Indicaciones",
  presentIllness: "Enfermedad actual",
  illnessDuration: "Tiempo de enfermedad",
  prognosis: "Pronóstico",
}

export interface AddEncounterProcedureInput {
  /** Servicio del catálogo para acto directo; excluyente con planItemId. */
  serviceId?: string | null
  toothNumber?: number | null
  surfaces?: string[] | null
  quadrant?: number | null
  arch?: string | null
  diagnosisCode?: string | null
  /** Lista del código; sin ella, la de la clínica. */
  diagnosisSystem?: string | null
  /** Ítem aceptado del plan: descripción y sitio se toman del ítem, sin cambios. */
  planItemId?: string | null
  /** Acto libre (sin servicio ni tratamiento): descripción obligatoria; nunca genera cargo. */
  description?: string | null
  /** Hallazgo del odontograma que trata un servicio directo; queda tratado al cerrar. */
  odontogramEntryId?: string | null
  /** Unidades del acto (1–99); el cargo es precio unitario × cantidad. */
  quantity?: number | null
  /**
   * Hacer un tratamiento que aún esperaba respuesta es aceptarlo: queda aceptado
   * y hecho en la misma atención, como el servicio directo, y sale de su
   * presupuesto en borrador. Uno de un presupuesto ya enviado espera su respuesta.
   */
  acceptWhenDone?: boolean
}

export interface ListEncountersInput {
  cursor?: string
  limit?: number
  status?: string
}

/** La atención con todo lo suyo; el producto agrega lo propio (odentIA: `odontogramEntries`). */
export type EncounterDetail = EncounterDetailBase & ProductParts

export interface EncounterDetailBase {
  encounter: EncounterRow
  teeth: number[]
  /** Incluye los anulados (con motivo) para conservar la traza del borrador. */
  procedures: EncounterProcedureRow[]
  /**
   * Diagnósticos de la atención (lista y código), anulados incluidos, con su
   * nombre en el catálogo: quien atiende lee «Caries dental», no solo DA08.0.
   */
  diagnoses: Array<EncounterDiagnosisRow & { diagnosisTitle: string | null }>
  /** Notas de evolución sin código (los diagnósticos históricos viven en `diagnoses`). */
  notes: EncounterNoteRow[]
  documents: EncounterDocumentRow[]
  /** clinical_note con kind='adenda', orden ascendente determinista, con quién la escribió. */
  addenda: Array<EncounterNoteRow & { authorName: string | null }>
  /** Ítems del plan vinculados a la atención (aceptados al vincular; su estado clínico no cambia al abrir). */
  plannedItems: EncounterItem[]
  /** Ítems indicados en esta atención (origen), con su decisión derivada. */
  indicatedItems: EncounterItem[]
  /**
   * Los presupuestos de lo indicado aquí, con su estado en palabras («Eligió la
   * opción A», «Anulado»): la atención firmada lo nombra y la anulada dice el que
   * anuló con ella (QA del 9 nov).
   */
  budgets: Array<{
    id: string
    budgetNumber: number
    status: string
    stateText: string
    /** Se anuló junto con esta atención (no antes, por su cuenta). */
    voidedWith: boolean
  }>
  /**
   * «Hoy viene a…» del borrador (`encounterVisitOf`): lo que trae, con o sin
   * cita. Nulo en una atención firmada o anulada.
   */
  visit: EncounterVisit | null
  /**
   * Tratamientos que esta atención deja por ejecutar: los vinculados y los
   * indicados aquí, sin repetir, que siguen abiertos y la persona no dejó fuera
   * (no aceptó o eligió otro camino). La pantalla lo dice, no lo calcula.
   */
  pendingTreatments: number
  /**
   * El motivo que se escribió al reservar su cita, si lo hay. Es una sugerencia: no
   * cuenta como motivo de consulta hasta que quien atiende lo confirma.
   */
  bookedReason: string | null
}

const PAGE_DEFAULT = 30
/** Lo que sigue por hacer de un tratamiento: ni hecho, ni suspendido, ni cerrado. */
const TO_EXECUTE_STATUSES = ["pendiente", "programado", "en_curso"]
export const ENCOUNTER_STATUSES = ["borrador", "finalizada", "anulada"] as const

const TEXT_LIMITS = {
  reason: 2000,
  evolution: 10000,
  indications: 5000,
  procedureDescription: 2000,
  presentIllness: 4000,
  illnessDuration: 200,
  prognosis: 2000,
} as const


function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function uniqueConstraintOf(error: unknown): string {
  const chain = [error, (error as { cause?: unknown })?.cause]
  for (const e of chain) {
    const r = e as Record<string, unknown> | null | undefined
    const found = r?.constraint_name ?? r?.constraint ?? r?.detail
    if (found) return String(found)
  }
  return String((error as Error)?.message ?? "")
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entity: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity,
    entityId,
    metadata: metadata ?? null,
  })
}

/** El «dónde» del producto de la clínica (odentIA: pieza, caras, cuadrante y arcada). */
const siteOf = async (tx: Db, orgId: string): Promise<ProductSite> => (await productHooks(tx, orgId)).site

/**
 * Los sitios sueltos de la atención (odentIA: sus piezas), validados por el
 * producto y sin repetir, en el orden de llegada.
 */
function dedupeTeeth(site: ProductSite, teeth: number[]): number[] {
  if (!Array.isArray(teeth)) throw validation("teeth debe ser una lista")
  const out: number[] = []
  for (const t of teeth) {
    if (site.code(t) === null) throw invalidField("teeth", site.invalid(t))
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/** Dos sitios iguales: mismo sistema y código, y los mismos calificadores en cualquier orden. */
const sameSite = (a: SiteColumns, b: SiteColumns) =>
  a.siteSystem === b.siteSystem &&
  a.siteCode === b.siteCode &&
  JSON.stringify([...a.siteQualifiers].sort()) === JSON.stringify([...b.siteQualifiers].sort())

/** Las filas de `encounter_site` de esos sitios sueltos. */
const encounterSites = (site: ProductSite, orgId: string, encounterId: string, teeth: number[]) =>
  teeth.map((t) => ({ organizationId: orgId, encounterId, siteSystem: site.system!, siteCode: site.code(t)! }))

/** Trim + cota; null/undefined/vacío → null (limpia el campo). */
function cleanText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  const t = value.trim()
  if (!t) return null
  if (t.length > max) throw invalidField(field, `Escribe como mucho ${max} caracteres.`)
  return t
}

/** Fila del encounter validando tenancy org + pertenencia al paciente. */
export async function requireEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Atención")
  return row
}

/**
 * Borrador abierto y llevado por quien escribe. Otro profesional lee la
 * atención y, para continuarla, toma el relevo (queda registrado).
 */
export function assertOpenDraft(row: EncounterRow, actorUserId: string): void {
  if (row.status === "finalizada") throw conflict("FINALIZED", "La atención está finalizada")
  if (row.status === "anulada") throw conflict("VOIDED", "La atención está anulada")
  assertAttending(row, actorUserId)
}


/**
 * Igual que requireEncounter pero bloqueando la fila FOR UPDATE: serializa
 * edición concurrente vs finalización (update/finalize/procedure/addenda
 * verifican el estado solo después de tomar el lock).
 */
export async function lockEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .for("update")
    .limit(1)
  if (!row) throw notFound("Atención")
  return row
}

/** Zona de la cita: la de su sede o, si la sede no tiene, la de la clínica. */
const appointmentTimeZone = sql<string>`coalesce(${branch.timezone}, ${orgProfile.timezone}, 'UTC')`

/** Una cita que todavía se puede atender (programada o confirmada). */
interface AttendableAppointment {
  id: string
  branchId: string
  startsAt: Date
  timeZone: string
}

/** Día local («2026-10-16») de un instante en una zona IANA. */
function localDateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
}

/**
 * La cita de hoy del paciente que sigue en pie (programada o confirmada) y aún
 * no tiene atención; si hay varias, la que llegó y, si ninguna, la más cercana
 * a la hora (ADR 0032). «Hoy» es el día en la zona de la sede de la cita.
 */
async function todaysAppointment(
  tx: Db,
  orgId: string,
  patientId: string,
  now: Date,
): Promise<AttendableAppointment | null> {
  const at = now.toISOString()
  const [row] = await tx
    .select({
      id: appointment.id,
      branchId: appointment.branchId,
      startsAt: appointment.startsAt,
      timeZone: appointmentTimeZone,
    })
    .from(appointment)
    .innerJoin(
      branch,
      and(eq(branch.id, appointment.branchId), eq(branch.organizationId, appointment.organizationId)),
    )
    .leftJoin(orgProfile, eq(orgProfile.organizationId, appointment.organizationId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        // Ventana amplia para el índice; el día exacto lo decide la zona.
        sql`${appointment.startsAt} between ${at}::timestamptz - interval '36 hours' and ${at}::timestamptz + interval '36 hours'`,
        sql`(${appointment.startsAt} at time zone ${appointmentTimeZone})::date = (${at}::timestamptz at time zone ${appointmentTimeZone})::date`,
        sql`not exists (select 1 from ${encounter} e where e.organization_id = ${appointment.organizationId} and e.appointment_id = ${appointment.id} and e.status <> 'anulada')`,
      ),
    )
    .orderBy(
      sql`${appointment.arrivedAt} is null`,
      sql`abs(extract(epoch from (${appointment.startsAt} - ${at}::timestamptz)))`,
      asc(appointment.startsAt),
    )
    .limit(1)
    .for("update", { of: appointment })
  return row ?? null
}

/**
 * Atender una cita con un borrador abierto sin cita, empezado ese mismo día:
 * es la misma visita, así que el borrador se une a la cita (y toma su sede si
 * no tenía) en vez de abrir otra atención. Al cerrarlo, la cita queda atendida.
 * Si el borrador ya es de esta cita, se continúa. Otro caso no se toca.
 */
async function joinOpenDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  visit: AttendableAppointment,
): Promise<EncounterRow | null> {
  const [draft] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "borrador"),
      ),
    )
    .for("update")
    .limit(1)
  if (!draft) return null
  if (draft.appointmentId === visit.id) return draft
  if (draft.appointmentId) return null
  if (localDateIn(draft.createdAt, visit.timeZone) !== localDateIn(visit.startsAt, visit.timeZone))
    return null
  const [joined] = await tx
    .update(encounter)
    .set({ appointmentId: visit.id, branchId: draft.branchId ?? visit.branchId, updatedAt: new Date() })
    .where(and(eq(encounter.id, draft.id), eq(encounter.organizationId, orgId)))
    .returning()
  if (!joined) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.appointment_joined", "encounter", joined.id, {
    patientId,
    appointmentId: visit.id,
  })
  return joined
}

/** El borrador abierto de un paciente, sin nada de su historia. */
export interface OpenEncounterRef {
  id: string
  professionalUserId: string
  startedAt: Date
  /** Empezó hoy, en el día de la clínica: si no, la app pregunta qué hacer con ella. */
  today: boolean
  /** Sin nada registrado: se descarta de un toque, sin motivo. */
  empty: boolean
}

/** Borrador abierto de un paciente, sin nada de la historia: cuál es, quién lo lleva, de qué día y si está vacío. */
export async function getOpenEncounterRef(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<OpenEncounterRef | null> {
  await requirePatient(tx, orgId, patientId)
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "borrador"),
      ),
    )
    .limit(1)
  if (!row) return null
  const { timezone } = await findOrgLocale(tx, orgId)
  const day = (at: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  return {
    id: row.id,
    professionalUserId: row.professionalUserId,
    startedAt: row.startedAt,
    // De hoy, o abierta hoy para una cita pasada (lleva la fecha de la cita, pero no quedó
    // abierta de otro día: se está registrando ahora).
    today: day(row.startedAt) === day(new Date()) || (row.appointmentId !== null && day(row.createdAt) === day(new Date())),
    empty: !(await encounterHasRecords(tx, orgId, row)),
  }
}

/**
 * Si la atención tiene algo registrado: lo escrito de la consulta (relato, examen, signos,
 * evolución, indicaciones, pronóstico), hallazgos, diagnósticos, procedimientos, documentos
 * (consentimientos, recetas, órdenes, descansos, formularios, archivos), lo indicado en el
 * Plan, controles, materiales o cobros (que salen de sus procedimientos). El motivo no cuenta:
 * suele venir de la cita. Lo que no está aquí lo frena igual la base al descartar.
 */
export async function encounterHasRecords(
  tx: Db,
  orgId: string,
  row: Pick<
    EncounterRow,
    "id" | "presentIllness" | "illnessDuration" | "vitals" | "evolution" | "indications" | "prognosis" | "examination"
  >,
): Promise<boolean> {
  const written = [row.presentIllness, row.illnessDuration, row.evolution, row.indications, row.prognosis]
  if (written.some((text) => typeof text === "string" && text.trim().length > 0)) return true
  const filled = (value: unknown): boolean =>
    value !== null &&
    value !== undefined &&
    (typeof value !== "object" || Object.values(value as Record<string, unknown>).some((item) => filled(item))) &&
    !(typeof value === "string" && value.trim() === "")
  if (filled(row.vitals) || filled(row.examination)) return true
  const [found] = await tx.execute<{ any: boolean }>(sql`
    select (
      exists (select 1 from encounter_procedure where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from encounter_diagnosis where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from clinical_note where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from clinical_form_response where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from clinical_order where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from consent_document where organization_id = ${orgId}
        and (encounter_id = ${row.id} or informed_encounter_id = ${row.id}))
      or exists (select 1 from medical_leave where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from patient_document_context where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from prescription where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from stock_movement where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from treatment_plan where organization_id = ${orgId} and origin_encounter_id = ${row.id})
      or exists (select 1 from treatment_plan_item where organization_id = ${orgId} and source_encounter_id = ${row.id})
      or exists (select 1 from clinical_follow_up where organization_id = ${orgId}
        and (origin_encounter_id = ${row.id} or completed_encounter_id = ${row.id}))
      or exists (select 1 from dental.odontogram_assessment where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from dental.periodontal_chart where organization_id = ${orgId} and encounter_id = ${row.id})
      or exists (select 1 from optical.lens_prescription where organization_id = ${orgId} and encounter_id = ${row.id})
    ) as any`)
  return found?.any === true
}

/**
 * «Descartar» (10 nov): una atención en borrador sin nada registrado se borra de un toque, sin
 * motivo. No queda en la Historia (no hay nada que contar); queda el evento de auditoría. Con
 * algo registrado se cierra o se anula con su motivo, como siempre. La base solo deja borrar
 * borradores, y lo que la nombra con contenido clínico frena el borrado (sus FK no se propagan).
 */
export async function discardEmptyEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<{ discarded: true; appointmentId: string | null }> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  const notEmpty = () =>
    conflict("ENCOUNTER_NOT_EMPTY", "Tiene algo registrado: termínala o anúlala con su motivo")
  if (await encounterHasRecords(tx, orgId, locked)) throw notEmpty()
  try {
    await tx.transaction(async (inner) => {
      await inner
        .delete(encounter)
        .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId), eq(encounter.status, "borrador")))
    })
  } catch (error) {
    // Algo la nombra (FK sin propagar): no está vacía.
    if (isForeignKeyViolation(error)) throw notEmpty()
    throw error
  }
  await audit(tx, orgId, actorUserId, "encounter.discarded", "encounter", encounterId, {
    patientId,
    startedAt: locked.startedAt.toISOString(),
    professionalUserId: locked.professionalUserId,
    appointmentId: locked.appointmentId,
    ...(locked.reason ? { hadReason: true } : {}),
  })
  // La Agenda deja de decir «En atención»; la llegada se conserva, como al anular.
  if (locked.appointmentId) await notifyAppointmentChanged(tx, orgId)
  return { discarded: true, appointmentId: locked.appointmentId }
}

export async function createEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateEncounterInput,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const site = await siteOf(tx, orgId)
  const selectedTeeth = input.teeth === undefined ? [] : dedupeTeeth(site, input.teeth)
  // La cita que motiva la atención fija la sede; su estado debe admitir que se
  // atienda (no cancelada, sin inasistencia ni ya atendida).
  let fromAppointment: AttendableAppointment | null = null
  if (input.appointmentId) {
    const [row] = await tx
      .select({
        id: appointment.id,
        branchId: appointment.branchId,
        startsAt: appointment.startsAt,
        status: appointment.status,
        timeZone: appointmentTimeZone,
      })
      .from(appointment)
      .innerJoin(
        branch,
        and(eq(branch.id, appointment.branchId), eq(branch.organizationId, appointment.organizationId)),
      )
      .leftJoin(orgProfile, eq(orgProfile.organizationId, appointment.organizationId))
      .where(
        and(
          eq(appointment.id, input.appointmentId),
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, patientId),
        ),
      )
      .for("update", { of: appointment })
      .limit(1)
    if (!row) throw notFound("Cita")
    // «Vino» deja la cita atendida sin su atención: su profesional la registra después
    // («Su cita del 9 nov quedó atendida sin registrar»). Solo si nadie la registró aún.
    const cameWithoutRecord =
      row.status === "atendida" &&
      !(await tx
        .select({ id: encounter.id })
        .from(encounter)
        .where(
          and(
            eq(encounter.organizationId, orgId),
            eq(encounter.appointmentId, row.id),
            ne(encounter.status, "anulada"),
          ),
        )
        .limit(1)
        .then((found) => found.length > 0)) &&
      // Solo la que cerró «Vino»: la atendida cuya atención se anuló no se vuelve a abrir así.
      (await tx
        .execute<{ by: string | null }>(sql`
          select metadata->>'by' as by from audit_event
          where organization_id = ${orgId} and entity = 'appointment' and entity_id = ${row.id}
            and action = 'appointment.status_atendida'
          order by created_at desc limit 1`)
        .then((found) => found[0]?.by === "vino"))
    if (!["programada", "confirmada"].includes(row.status) && !cameWithoutRecord) {
      throw conflict(
        "APPOINTMENT_NOT_ATTENDABLE",
        "Solo se atiende una cita programada o confirmada",
      )
    }
    fromAppointment = row
    const continued = await joinOpenDraft(tx, orgId, actorUserId, patientId, row)
    if (continued) {
      // La cita que se agendó para lo aceptado trae sus tratamientos (ADR 0034).
      await linkAppointmentItems(tx, orgId, patientId, row.id, continued.id)
      // Atender a quien nadie marcó: la llegada queda anotada a esta hora.
      await markArrivedOnAttend(tx, orgId, actorUserId, row.id)
      await notifyAppointmentChanged(tx, orgId)
      return continued
    }
  }
  // Sin cita indicada, la atención se une a la cita de hoy que sigue en pie:
  // así, al cerrarla, la cita queda atendida y sus controles hechos.
  const joinedToday = fromAppointment === null
  if (joinedToday) fromAppointment = await todaysAppointment(tx, orgId, patientId, new Date())
  let branchId: string | null = fromAppointment?.branchId ?? null
  // La sede de la cita de hoy manda sobre la que se eligió por defecto.
  if (input.branchId && !(joinedToday && fromAppointment)) {
    const [found] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.id, input.branchId), eq(branch.organizationId, orgId)))
      .limit(1)
    if (!found) throw branchNotFound()
    branchId = found.id
  }
  // Sin cita ni sede indicada, una clínica de una sola sede no tiene nada que
  // elegir: la atención nace en ella y lo que se cobre llega a su caja.
  if (!branchId) {
    const active = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
      .limit(2)
    if (active.length === 1) branchId = active[0]!.id
  }
  // El motivo no se pide al abrir (ADR 0032 y 0098) y nace vacío: el que se escribió
  // al reservar es de quien reservó, no del profesional. La atención lo ofrece como
  // sugerencia (`bookedReason`) y el cierre exige que alguien lo confirme o escriba.
  const reason = cleanText(input.reason, "reason", TEXT_LIMITS.reason)
  // Profesional que atiende: por defecto quien abre (también desde la cita de
  // otro profesional: quien cubre a otro es quien escribe). Otro elegido debe
  // ser miembro con escritura clínica, nunca caja ni recepción.
  let professionalUserId = actorUserId
  if (input.professionalUserId && input.professionalUserId !== actorUserId) {
    const [membership] = await tx
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, input.professionalUserId)))
      .limit(1)
    if (!membership) throw notFound("Profesional")
    if (!canAttend(membership.role))
      throw validation(
        "Quien atiende debe poder escribir en la historia clínica: elige a un profesional clínico",
      )
    professionalUserId = input.professionalUserId
  }
  // pertenencia/estado/decisión ocurre antes de crear la atención para que un
  // planItemIds inválido no deje un borrador vacío (409/404/422, sin DRAFT_OPEN).
  // La cita que se agendó para lo aceptado trae sus tratamientos (ADR 0034).
  const fromCita = fromAppointment ? await appointmentItemsToLink(tx, orgId, patientId, fromAppointment.id) : []
  const planItemIds = [
    ...new Set(
      [...(input.planItemIds ?? []), ...fromCita].map((id) => id.trim()).filter((id) => id.length > 0),
    ),
  ]
  if (planItemIds.length > 52) throw validation("planItemIds admite como máximo 52 tratamientos")
  const acceptedPlans =
    planItemIds.length > 0 ? await assertLinkablePlans(tx, orgId, patientId, planItemIds) : []
  const teeth = dedupeTeeth(site, [
    ...selectedTeeth,
    ...acceptedPlans.flatMap((plan) => (plan.toothNumber == null ? [] : [plan.toothNumber])),
  ])
  try {
    const [row] = await tx
      .insert(encounter)
      .values({
        organizationId: orgId,
        patientId,
        branchId,
        professionalUserId,
        appointmentId: fromAppointment?.id ?? null,
        status: "borrador",
        reason,
        // La atención de una cita de otro día es de ese día: la historia la fecha cuando fue,
        // no cuando se escribió (la auditoría guarda cuándo se registró).
        ...(fromAppointment && localDateIn(fromAppointment.startsAt, fromAppointment.timeZone) < localDateIn(new Date(), fromAppointment.timeZone)
          ? { startedAt: fromAppointment.startsAt }
          : {}),
      })
      .returning()
    if (!row) throw new Error("No se pudo crear la atención")
    if (teeth.length > 0) {
      await tx
        .insert(encounterSite)
        .values(
          encounterSites(site, orgId, row.id, teeth),
        )
    }
    if (acceptedPlans.length > 0) {
      // Vínculo encounter_plan_item: conserva el plan sin marcarlo realizado
      // (el estado clínico solo cambia al registrar el procedimiento).
      await tx
        .insert(encounterPlanItem)
        .values(
          acceptedPlans.map((plan) => ({
            organizationId: orgId,
            encounterId: row.id,
            planItemId: plan.id,
          })),
        )
        .onConflictDoNothing({
          target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId],
        })
    }
    await audit(tx, orgId, actorUserId, "encounter.created", "encounter", row.id, {
      patientId,
      teeth,
      planItemIds,
      appointmentId: fromAppointment?.id ?? null,
    })
    if (fromAppointment) {
      // La cita pasa a «En atención»; si nadie marcó la llegada, queda anotada ahora.
      await markArrivedOnAttend(tx, orgId, actorUserId, fromAppointment.id)
      await notifyAppointmentChanged(tx, orgId)
    }
    return row
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    if (uniqueConstraintOf(e).includes("encounter_patient_open_uidx")) {
      throw conflict("DRAFT_OPEN", "Ya hay una atención en curso para este paciente")
    }
    if (uniqueConstraintOf(e).includes("encounter_appointment_active_uidx")) {
      throw conflict("APPOINTMENT_HAS_ENCOUNTER", "Esta cita ya tiene una atención")
    }
    throw e
  }
}

/** El tratamiento que se trae a la atención, con su sitio suelto si tiene (odentIA: su pieza). */
type LinkablePlan = { id: string; toothNumber: number | null }

/**
 * Valida que cada tratamiento sea del mismo paciente/org, esté pendiente o
 * programado, aceptado en su presupuesto (decision aceptado) y con presupuesto
 * vigente (no cancelado/histórico). No muta estados: solo habilita el vínculo.
 */
/**
 * Lo que se agendó con la cita (`appointment_plan_item`) y aún se puede traer a
 * su atención: aceptado en su presupuesto vigente y sin terminar. Lo que ya no
 * cumple (se completó o cambió de decisión) simplemente no se trae.
 */
async function appointmentItemsToLink(
  tx: Db,
  orgId: string,
  patientId: string,
  appointmentId: string,
): Promise<string[]> {
  // Donde lo indicado queda aceptado al indicarlo (latidIA), no se pide presupuesto.
  const { budgetRequired } = await productHooks(tx, orgId)
  const budgeted = budgetRequired
    ? sql`and (exists (select 1 from treatment_budget b where b.id = i.budget_id and b.organization_id = i.organization_id
        and b.status in ('aceptado','parcial'))
        or (i.budget_id is null and exists (select 1 from encounter_procedure done where done.organization_id = i.organization_id
          and done.plan_item_id = i.id and done.voided_at is null)))`
    : sql``
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id from appointment_plan_item ap
      join treatment_plan_item i on i.id = ap.plan_item_id and i.organization_id = ap.organization_id
    where ap.organization_id = ${orgId} and ap.patient_id = ${patientId} and ap.appointment_id = ${appointmentId}
      and i.decision_status = 'aceptado' and i.status in ('pendiente','programado','en_curso')
      ${budgeted}
    order by i.sort_order, i.id`)
  return rows.map((row) => row.id)
}

/** Une a una atención ya abierta lo que se agendó con su cita. */
async function linkAppointmentItems(
  tx: Db,
  orgId: string,
  patientId: string,
  appointmentId: string,
  encounterId: string,
): Promise<void> {
  const ids = await appointmentItemsToLink(tx, orgId, patientId, appointmentId)
  if (ids.length === 0) return
  await tx
    .insert(encounterPlanItem)
    .values(ids.map((planItemId) => ({ organizationId: orgId, encounterId, planItemId })))
    .onConflictDoNothing({ target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId] })
}

/**
 * Un tratamiento sin presupuesto que quedó aceptado en una atención (al hacerlo,
 * o el directo de varias sesiones): tiene un procedimiento vigente. La misma
 * regla que `acceptedInAttention` del plan.
 */
async function acceptedWhenDone(tx: Db, orgId: string, itemId: string): Promise<boolean> {
  const [done] = await tx
    .select({ id: encounterProcedure.id })
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.planItemId, itemId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .limit(1)
  return Boolean(done)
}

export async function assertLinkablePlans(
  tx: Db,
  orgId: string,
  patientId: string,
  planItemIds: string[],
): Promise<LinkablePlan[]> {
  const { site, budgetRequired } = await productHooks(tx, orgId)
  const rows = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        inArray(treatmentPlanItem.id, planItemIds),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
  if (rows.length !== planItemIds.length) throw notFound("Ítem del plan")
  // Orden estable plan→presupuesto→ítem, igual que el resto de rutas.
  rows.sort(
    (a, b) =>
      a.planId.localeCompare(b.planId) ||
      (a.budgetId ?? "").localeCompare(b.budgetId ?? "") ||
      a.id.localeCompare(b.id),
  )
  for (const planId of [...new Set(rows.map((r) => r.planId))].sort()) {
    await tx.execute(
      sql`select "id" from "treatment_plan" where "id" = ${planId} and "organization_id" = ${orgId} for update`,
    )
  }
  for (const budgetId of [
    ...new Set(rows.map((r) => r.budgetId).filter((id): id is string => id !== null)),
  ].sort()) {
    await tx.execute(
      sql`select "id" from "treatment_budget" where "id" = ${budgetId} and "organization_id" = ${orgId} for update`,
    )
  }
  const accepted: LinkablePlan[] = []
  for (const row of rows) {
    const [plan] = await tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, row.id),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
      .limit(1)
      .for("update")
    if (!plan) throw notFound("Ítem del plan")
    if (!["pendiente", "programado", "en_curso"].includes(plan.status)) {
      throw conflict(
        "ITEM_NOT_READY",
        "Solo se pueden vincular tratamientos pendientes, programados o en curso",
      )
    }
    // Donde lo indicado queda aceptado al indicarlo (latidIA), basta la decisión.
    if (!budgetRequired) {
      if (plan.decisionStatus !== "aceptado")
        throw conflict("ITEM_NOT_ACCEPTED", "Solo se pueden vincular tratamientos aceptados")
      accepted.push({ id: plan.id, toothNumber: plan.siteSystem === site.system ? site.value(plan.siteCode) : null })
      continue
    }
    if (
      plan.decisionStatus === "aceptado" &&
      !plan.budgetId &&
      (await acceptedWhenDone(tx, orgId, plan.id))
    ) {
      // Aceptado al hacerlo (o directo de varias sesiones): su sesión siguiente se trae igual.
      accepted.push({
        id: plan.id,
        toothNumber: plan.siteSystem === site.system ? site.value(plan.siteCode) : null,
      })
      continue
    }
    if (!plan.budgetId) {
      throw conflict(
        "ITEM_NOT_ACCEPTED",
        "Solo se pueden vincular tratamientos aceptados en su presupuesto vigente",
      )
    }
    if (plan.decisionStatus !== "aceptado") {
      throw conflict(
        "ITEM_NOT_ACCEPTED",
        "Solo se pueden vincular tratamientos aceptados en su presupuesto vigente",
      )
    }
    const [budget] = await tx
      .select({ status: treatmentBudget.status })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.id, plan.budgetId), eq(treatmentBudget.organizationId, orgId)))
      .limit(1)
    if (!budget || (budget.status !== "aceptado" && budget.status !== "parcial")) {
      throw conflict(
        "BUDGET_CLOSED",
        "El presupuesto del tratamiento no tiene una aceptación vigente",
      )
    }
    accepted.push({ id: plan.id, toothNumber: plan.siteSystem === site.system ? site.value(plan.siteCode) : null })
  }
  return accepted
}

export async function getEncounterDetail(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterDetail> {
  const row = await requireEncounter(tx, orgId, patientId, encounterId)
  const site = await siteOf(tx, orgId)
  const childOf = and(
    eq(clinicalNote.encounterId, encounterId),
    eq(clinicalNote.organizationId, orgId),
  )
  const [
    teethRows,
    procedures,
    notes,
    addenda,
    documents,
    plannedItems,
    indicatedItems,
    diagnoses,
    bookedReason,
  ] = await Promise.all([
    tx
      .select({ siteSystem: encounterSite.siteSystem, siteCode: encounterSite.siteCode })
      .from(encounterSite)
      .where(
        and(eq(encounterSite.encounterId, encounterId), eq(encounterSite.organizationId, orgId)),
      )
      .orderBy(asc(encounterSite.siteCode)),
    tx
      .select()
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.encounterId, encounterId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
      .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id)),
    tx
      .select()
      .from(clinicalNote)
      .where(and(childOf, eq(clinicalNote.kind, "evolucion")))
      .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id)),
    // La adenda dice quién la escribió (NTS 139: toda anotación lleva a su autor).
    tx
      .select({ ...getTableColumns(clinicalNote), authorName: user.name })
      .from(clinicalNote)
      .leftJoin(user, eq(user.id, clinicalNote.authorUserId))
      .where(and(childOf, eq(clinicalNote.kind, "adenda")))
      .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id)),
    listEncounterDocuments(tx, orgId, patientId, encounterId),
    tx
      .select({ item: treatmentPlanItem })
      .from(encounterPlanItem)
      .innerJoin(treatmentPlanItem, eq(treatmentPlanItem.id, encounterPlanItem.planItemId))
      .where(
        and(
          eq(encounterPlanItem.encounterId, encounterId),
          eq(encounterPlanItem.organizationId, orgId),
        ),
      )
      .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id)),
    tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.sourceEncounterId, encounterId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
      .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id)),
    tx
      .select({ ...getTableColumns(encounterDiagnosis), diagnosisTitle: diagnosisCatalog.title })
      .from(encounterDiagnosis)
      .leftJoin(
        diagnosisCatalog,
        and(
          eq(diagnosisCatalog.systemKey, encounterDiagnosis.diagnosisSystem),
          eq(diagnosisCatalog.code, encounterDiagnosis.diagnosisCode),
        ),
      )
      .where(
        and(
          eq(encounterDiagnosis.encounterId, encounterId),
          eq(encounterDiagnosis.organizationId, orgId),
        ),
      )
      .orderBy(asc(encounterDiagnosis.createdAt), asc(encounterDiagnosis.id)),
    // Solo un borrador tiene un motivo por confirmar: una atención firmada o anulada ya no.
    row.status === "borrador" ? bookedReasonOf(tx, orgId, row.appointmentId) : Promise.resolve(null),
  ])
  // No basta lo vinculado: el vínculo nace cuando la sesión arranca, así que una
  // indicación recién propuesta solo está entre lo indicado.
  const attention = new Map(
    [...plannedItems.map((link) => link.item), ...indicatedItems].map((item) => [item.id, item] as const),
  )
  const counts = await sessionCountsOf(tx, orgId, [...attention.keys()])
  const removable =
    row.status === "borrador"
      ? await removableFromEncounter(tx, orgId, encounterId, row.professionalUserId)
      : new Set<string>()
  // El consentimiento va con el tratamiento: el Plan de la atención también lo dice.
  const consents = await treatmentConsentStates(tx, orgId, [...attention.keys()])
  const withProgress = <T extends { id: string }>(item: T) => ({
    ...item,
    sessionsDone: counts.get(item.id)?.done ?? 0,
    removable: removable.has(item.id),
    consent: consents.get(item.id)?.state ?? null,
    consentMissing: consents.get(item.id)?.missing ?? [],
  })
  const pendingTreatments = [...attention.values()].filter(
    (item) => TO_EXECUTE_STATUSES.includes(item.status) && !isLeftOut(item.decisionStatus),
  ).length
  return {
    encounter: row,
    teeth: teethRows.map((r) => site.value(r.siteCode)).filter((tooth): tooth is number => tooth != null),
    procedures: procedures.map((row) => withSite(site, row)),
    diagnoses: diagnoses.map((row) => withSite(site, row)),
    notes: notes.map((row) => withSite(site, row)),
    // Lo del producto (odentIA: los hallazgos del odontograma de la atención).
    ...(await (await productHooks(tx, orgId)).encounterDetailParts(tx, { orgId, patientId, encounterId })),
    documents,
    addenda: addenda.map((row) => withSite(site, row)),
    plannedItems: plannedItems.map((link) => withProgress(withSite(site, link.item))),
    indicatedItems: indicatedItems.map((item) => withProgress(withSite(site, item))),
    budgets: await encounterBudgetsOf(tx, orgId, encounterId, row.voidedAt),
    pendingTreatments,
    bookedReason,
    visit: await encounterVisitOf(tx, orgId, row),
  }
}

/** Los presupuestos con líneas de lo indicado en la atención, en orden y con su estado dicho. */
async function encounterBudgetsOf(
  tx: Db,
  orgId: string,
  encounterId: string,
  voidedAt: Date | null,
): Promise<EncounterDetailBase["budgets"]> {
  const budgets = await tx
    .selectDistinct({
      id: treatmentBudget.id,
      budgetNumber: treatmentBudget.budgetNumber,
      status: treatmentBudget.status,
      updatedAt: treatmentBudget.updatedAt,
    })
    .from(treatmentBudget)
    .innerJoin(
      treatmentBudgetItem,
      and(eq(treatmentBudgetItem.organizationId, treatmentBudget.organizationId), eq(treatmentBudgetItem.budgetId, treatmentBudget.id)),
    )
    .innerJoin(
      treatmentPlanItem,
      and(eq(treatmentPlanItem.organizationId, treatmentBudgetItem.organizationId), eq(treatmentPlanItem.id, treatmentBudgetItem.planItemId)),
    )
    .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentPlanItem.sourceEncounterId, encounterId)))
    .orderBy(asc(treatmentBudget.budgetNumber))
  if (budgets.length === 0) return []
  const ids = budgets.map((budget) => budget.id)
  const [lines, options] = await Promise.all([
    tx
      .select({
        budgetId: treatmentBudgetItem.budgetId,
        decision: treatmentBudgetItem.decision,
        optionId: treatmentBudgetItem.optionId,
        planItemId: treatmentBudgetItem.planItemId,
      })
      .from(treatmentBudgetItem)
      .where(and(eq(treatmentBudgetItem.organizationId, orgId), inArray(treatmentBudgetItem.budgetId, ids))),
    tx
      .select({
        id: treatmentBudgetOption.id,
        budgetId: treatmentBudgetOption.budgetId,
        decision: treatmentBudgetOption.decision,
        position: treatmentBudgetOption.position,
      })
      .from(treatmentBudgetOption)
      .where(and(eq(treatmentBudgetOption.organizationId, orgId), inArray(treatmentBudgetOption.budgetId, ids))),
  ])
  return budgets.map(({ updatedAt, ...budget }) => ({
    ...budget,
    // Anulado en el mismo paso que la atención (`settleEncounterVoidBudgets`, en su transacción).
    voidedWith:
      budget.status === "cancelado" && voidedAt !== null && Math.abs(updatedAt.getTime() - voidedAt.getTime()) < 60_000,
    stateText: budgetStateText({
      status: budget.status,
      items: lines.filter((line) => line.budgetId === budget.id),
      options: options.filter((option) => option.budgetId === budget.id),
    }),
  }))
}

/**
 * Para qué se agendó la cita de la atención, para ofrecerlo como motivo, nunca
 * para darlo por firmado (ADR 0139). En orden: el motivo escrito al reservarla;
 * si no hay, los controles que se reservaron con ella; si tampoco, los tratamientos
 * que se agendaron con ella («Continúa: Endodoncia posterior vital de la 46»).
 */
async function bookedReasonOf(tx: Db, orgId: string, appointmentId: string | null): Promise<string | null> {
  if (!appointmentId) return null
  const [booked] = await tx
    .select({ reason: appointment.reason, serviceName: appointment.serviceName })
    .from(appointment)
    .where(and(eq(appointment.id, appointmentId), eq(appointment.organizationId, orgId)))
    .limit(1)
  if (!booked) return null
  const written = booked.reason?.trim()
  if (written) return written
  // Un motivo es una línea: con muchos, los tres primeros y cuántos más.
  const oneLine = (words: string[]) => {
    const shown = words.length > 3 ? [...words.slice(0, 3), `${words.length - 3} más`] : words
    return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} y ${shown.at(-1)}`
  }
  // Todos los controles reservados con la cita («Control A y Control B»), no solo el primero.
  const controls = await tx
    .select({ title: clinicalFollowUp.title })
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.appointmentId, appointmentId),
        ne(clinicalFollowUp.status, "cancelado"),
      ),
    )
    .orderBy(asc(clinicalFollowUp.createdAt), asc(clinicalFollowUp.id))
  const controlTitles = [...new Set(controls.map((control) => control.title.trim()).filter(Boolean))]
  if (controlTitles.length > 0) return oneLine(controlTitles)
  const items = await tx
    .select({ title: treatmentPlanItem.title, siteCode: treatmentPlanItem.siteCode })
    .from(appointmentPlanItem)
    .innerJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, appointmentPlanItem.planItemId),
        eq(treatmentPlanItem.organizationId, appointmentPlanItem.organizationId),
      ),
    )
    .where(
      and(
        eq(appointmentPlanItem.organizationId, orgId),
        eq(appointmentPlanItem.appointmentId, appointmentId),
        // Lo cancelado o reemplazado después de agendar ya no se continúa.
        notInArray(treatmentPlanItem.status, DROPPED_PLAN_ITEM_STATUSES),
      ),
    )
    .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  // Sin tratamientos ni controles, lo que dice la cita: su servicio («Limpieza»). Antes
  // decía «Sin cita» aunque la persona viniera con una (QA del 10 nov, C16).
  if (items.length === 0) return booked.serviceName?.trim() || null
  const { site } = await productHooks(tx, orgId)
  // «de la 46», como se dice la pieza en el resto de textos; sin pieza (o en latidIA), solo el título.
  const words = items.map((item) => {
    const where = site.value(item.siteCode)
    return where != null ? `${item.title.trim()} de la ${where}` : item.title.trim()
  })
  return `Continúa: ${oneLine(words)}`
}

/** Atención en la lista del paciente, con lo necesario para reconocerla. */
export type EncounterListItem = EncounterRow & {
  diagnosisCodes: string[]
  procedureCount: number
}

export async function listEncounters(
  tx: Db,
  orgId: string,
  patientId: string,
  input: ListEncountersInput,
): Promise<{ items: EncounterListItem[]; nextCursor: string | null }> {
  await requirePatient(tx, orgId, patientId)
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  if (
    input.status !== undefined &&
    !(ENCOUNTER_STATUSES as readonly string[]).includes(input.status)
  ) {
    throw validation("status debe ser 'borrador', 'finalizada' o 'anulada'")
  }
  const conditions = [eq(encounter.patientId, patientId), eq(encounter.organizationId, orgId)]
  if (input.status) conditions.push(eq(encounter.status, input.status))
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    const ts = new Date(decoded.ts)
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido")
    conditions.push(
      or(
        lt(encounter.createdAt, ts),
        and(eq(encounter.createdAt, ts), lt(encounter.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select()
    .from(encounter)
    .where(and(...conditions))
    .orderBy(desc(encounter.createdAt), desc(encounter.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  // Lo que la lista necesita para reconocer cada atención sin abrirla:
  // diagnósticos y actos vigentes (los anulados no cuentan).
  const ids = page.map((row) => row.id)
  const codes = ids.length
    ? await tx
        .select({ encounterId: encounterDiagnosis.encounterId, code: encounterDiagnosis.diagnosisCode })
        .from(encounterDiagnosis)
        .where(
          and(
            eq(encounterDiagnosis.organizationId, orgId),
            inArray(encounterDiagnosis.encounterId, ids),
            isNull(encounterDiagnosis.voidedAt),
          ),
        )
        .orderBy(asc(encounterDiagnosis.createdAt))
    : []
  const counts = ids.length
    ? await tx
        .select({ encounterId: encounterProcedure.encounterId, n: sql<number>`count(*)::int` })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.encounterId, ids),
            isNull(encounterProcedure.voidedAt),
          ),
        )
        .groupBy(encounterProcedure.encounterId)
    : []
  const procedureCount = new Map(counts.map((row) => [row.encounterId, row.n]))
  return {
    items: page.map((row) => ({
      ...row,
      diagnosisCodes: [
        ...new Set(codes.filter((c) => c.encounterId === row.id).map((c) => c.code)),
      ],
      procedureCount: procedureCount.get(row.id) ?? 0,
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  }
}
export async function updateEncounterDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  patch: UpdateEncounterDraftPatch,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  // Otra pestaña (u otra persona tras el relevo) guardó otro texto en el mismo campo:
  // se avisa en vez de pisarlo. Lo escrito sigue en la pantalla de quien guarda.
  // Si lo guardado ya es lo que llega (un reintento que sí había llegado), no hay conflicto.
  const stale: Record<string, string> = {}
  for (const field of ENCOUNTER_TEXT_FIELDS) {
    const expected = patch.base?.[field]
    const sent = patch[field]
    if (expected === undefined || sent === undefined) continue
    const stored = (locked[field] ?? "").trim()
    if (stored === (expected ?? "").trim() || stored === (sent ?? "").trim()) continue
    stale[field] = `Otra pestaña o persona guardó otra «${ENCOUNTER_TEXT_LABELS[field]}» mientras escribías. Copia lo tuyo si lo necesitas y recarga para ver lo último.`
  }
  const staleFields = Object.keys(stale)
  if (staleFields.length > 0) {
    throw new ServiceError("STALE_DRAFT", 409, stale[staleFields[0] as string] as string, stale)
  }
  const set: Partial<typeof encounter.$inferInsert> = {}
  if (patch.branchId !== undefined) {
    if (patch.branchId !== null) {
      const [found] = await tx
        .select({ id: branch.id })
        .from(branch)
        .where(and(eq(branch.id, patch.branchId), eq(branch.organizationId, orgId)))
        .limit(1)
      if (!found) throw branchNotFound()
    }
    set.branchId = patch.branchId
  }
  if (patch.reason !== undefined) set.reason = cleanText(patch.reason, "reason", TEXT_LIMITS.reason)
  if (patch.evolution !== undefined)
    set.evolution = cleanText(patch.evolution, "evolution", TEXT_LIMITS.evolution)
  if (patch.indications !== undefined)
    set.indications = cleanText(patch.indications, "indications", TEXT_LIMITS.indications)
  const site = await siteOf(tx, orgId)
  const teeth = patch.teeth === undefined ? undefined : dedupeTeeth(site, patch.teeth)
  // El examen y los signos vitales son los del producto de la clínica (issue 229).
  const hooks = await productHooks(tx, orgId)
  if (patch.examination !== undefined) set.examination = hooks.examination.parse(patch.examination)
  for (const key of ["presentIllness", "illnessDuration", "prognosis"] as const) {
    if (patch[key] !== undefined) set[key] = cleanText(patch[key], key, TEXT_LIMITS[key])
  }
  if (patch.vitals !== undefined) {
    const parsed = parseVitals(patch.vitals, hooks.vitals)
    if (!parsed.ok) {
      const bySign = vitalsErrors(patch.vitals as Record<string, unknown> | null, hooks.vitals)
      throw validation(
        parsed.error,
        Object.keys(bySign).length > 0
          ? Object.fromEntries(Object.entries(bySign).map(([key, message]) => [`vitals.${key}`, message]))
          : { vitals: parsed.error },
      )
    }
    set.vitals = parsed.value
  }
  const [updated] = await tx
    .update(encounter)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(encounter.id, encounterId))
    .returning()
  if (!updated) throw notFound("Atención")
  if (teeth !== undefined) {
    await tx.delete(encounterSite).where(eq(encounterSite.encounterId, encounterId))
    if (teeth.length > 0) {
      await tx
        .insert(encounterSite)
        .values(encounterSites(site, orgId, encounterId, teeth))
    }
  }
  await audit(tx, orgId, actorUserId, "encounter.updated", "encounter", encounterId, {
    patientId,
    teeth,
  })
  return updated
}

/**
 * Plan contenedor del tratamiento directo: el plan vigente más reciente del
 * paciente; si no tiene ninguno, nace aquí con título estándar.
 */
async function getOrCreateDirectPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: treatmentPlan.id })
    .from(treatmentPlan)
    .where(
      and(
        eq(treatmentPlan.organizationId, orgId),
        eq(treatmentPlan.patientId, patientId),
        eq(treatmentPlan.isLegacy, false),
      ),
    )
    .orderBy(desc(treatmentPlan.createdAt), desc(treatmentPlan.id))
    .limit(1)
  if (existing) return existing.id
  const created = await createTreatmentPlan(tx, orgId, actorUserId, patientId, {
    title: "Plan de tratamiento",
    originEncounterId: encounterId,
  })
  return created.id
}

/**
 * El tratamiento abierto y aceptado del plan con ese servicio, si lo hay. Si
 * existe, registrar el servicio lo ejecuta: no crea otra indicación en el plan
 * (ADR 0100, QA CT: la resina se presupuestaba otra vez). Con la pieza dicha,
 * solo el de esa pieza o el que aún no la tiene: la endodoncia de la 21 no es
 * una sesión de la que sigue en curso en la 11.
 */
async function openAcceptedPlanItemFor(
  tx: Db,
  orgId: string,
  patientId: string,
  serviceId: string,
  siteCode: string | null,
): Promise<string | null> {
  const rows = await tx
    .select({ id: treatmentPlanItem.id, siteCode: treatmentPlanItem.siteCode })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.serviceId, serviceId),
        eq(treatmentPlanItem.decisionStatus, "aceptado"),
        ne(treatmentPlanItem.status, "realizado"),
        ne(treatmentPlanItem.status, "cancelado"),
        ne(treatmentPlanItem.status, "reemplazado"),
        ne(treatmentPlanItem.status, "suspendido"),
      ),
    )
    .orderBy(asc(treatmentPlanItem.id))
  const row = rows.find((item) => !siteCode || !item.siteCode || item.siteCode === siteCode)
  return row?.id ?? null
}

/** La pieza (o el sitio) que trae lo pedido, si se dijo; sin ella, ninguna. */
async function requestedSiteCode(tx: Db, orgId: string, input: AddEncounterProcedureInput): Promise<string | null> {
  const site = await siteOf(tx, orgId)
  try {
    return site.columns(siteInputOf(site, input)).siteCode
  } catch {
    // Un sitio mal dicho se rechaza más adelante con su campo; aquí no decide nada.
    return null
  }
}

export async function addEncounterProcedure(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: AddEncounterProcedureInput,
): Promise<EncounterProcedureRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  const requestedServiceId = input.serviceId?.trim() ? input.serviceId.trim() : null
  const linkedPlanItemId =
    requestedServiceId && !input.planItemId
      ? await openAcceptedPlanItemFor(tx, orgId, patientId, requestedServiceId, await requestedSiteCode(tx, orgId, input))
      : null
  const serviceIdParam = linkedPlanItemId ? null : requestedServiceId
  const planItemIdParam = input.planItemId ?? linkedPlanItemId
  if (serviceIdParam && planItemIdParam) {
    throw validation(
      "Selecciona un servicio del catálogo o un tratamiento del presupuesto, no ambos",
    )
  }
  // Sin servicio ni tratamiento es un acto libre: descripción obligatoria y
  // jamás genera cargo (no hay tarifa fuera del catálogo).
  const freeDescription = cleanText(
    input.description,
    "description",
    TEXT_LIMITS.procedureDescription,
  )
  if (!serviceIdParam && !planItemIdParam && !freeDescription) {
    throw invalidField(
      "serviceId",
      "Selecciona un servicio del catálogo, un tratamiento del presupuesto o describe el acto libre",
    )
  }
  // Snapshot desde el plan (misma org + paciente; anti-traversal): la
  // ejecución toma descripción, sitio y codificaciones del ítem aceptado.
  let planServiceId: string | null = null
  let planTitle = ""
  let planScope: string | null = null
  const site = await siteOf(tx, orgId)
  const noSite: SiteColumns = { siteSystem: null, siteCode: null, siteQualifiers: [] }
  let planSite: SiteColumns = noSite
  let planDiagnosis: string | null = null
  let planDiagnosisSystem: string | null = null
  let planCodings: Array<{ system: string; code: string; version: string; display: string }> = []
  let planPriceCents: number | null = null
  let planCurrency: string | null = null
  /**
   * Esperaba respuesta y se acepta al hacerlo (`acceptWhenDone`). Con una sola
   * sesión prevista se cierra como el servicio directo; con más, queda en curso.
   */
  let acceptedNow = false
  let acceptedPlannedSessions = 1
  let draftBudgetId: string | null = null
  if (planItemIdParam) {
    const { item: plan, budget } = await lockPlanItemForExecution(
      tx,
      orgId,
      patientId,
      planItemIdParam,
    )
    if (["realizado", "cancelado", "reemplazado"].includes(plan.status)) {
      throw conflict("ITEM_CLOSED", "El tratamiento ya está cerrado")
    }
    if (plan.status === "suspendido")
      throw conflict("ITEM_NOT_READY", "El tratamiento está suspendido")
    // Solo presupuesto aceptado o servicio directo explícito: setPlanItemStatus
    // vuelve a exigirlo, pero aquí el error es específico antes de insertar.
    if (plan.decisionStatus !== "aceptado") {
      const awaiting = plan.decisionStatus === "pendiente" && (!budget || budget.status === "borrador")
      if (!input.acceptWhenDone || !awaiting) {
        throw conflict(
          "ITEM_NOT_ACCEPTED",
          budget && budget.status !== "borrador" && input.acceptWhenDone
            ? "Está en un presupuesto que el paciente aún no respondió: anota su respuesta en el presupuesto"
            : "Solo se pueden realizar tratamientos aceptados en su presupuesto vigente",
        )
      }
      acceptedNow = true
      acceptedPlannedSessions = plan.plannedSessions
      draftBudgetId = budget?.id ?? null
    }
    // Histórico ambiguo heredado: nunca se factura como múltiples actos ni se
    // elige un principal; se pide una nueva indicación exacta.
    assertExecutableCodings(plan.codings)
    // Lo que llega del sitio se compara con el del tratamiento: no cambia.
    planSite = { siteSystem: plan.siteSystem, siteCode: plan.siteCode, siteQualifiers: plan.siteQualifiers }
    const given = siteInputOf(site, input)
    const pending = plan.scope ? (site.pending?.(planSite, plan.scope) ?? null) : null
    if (pending) {
      // Indicado con la pieza o la cara por definir: se define al hacerlo, con las
      // reglas de su ámbito, y queda también en el tratamiento. Lo que ya se dijo
      // al indicarlo (la pieza) no cambia.
      if (Object.keys(given).length === 0) throw invalidField("toothNumber", pending.ask)
      const [offer] = plan.serviceId
        ? await tx.select().from(serviceCatalog).where(and(eq(serviceCatalog.id, plan.serviceId), eq(serviceCatalog.organizationId, orgId))).limit(1)
        : []
      const asked = site.columns({ ...site.fields(planSite), ...given }, { scope: plan.scope!, surfaces: offer ? await surfaceLimits(tx, orgId, offer) : undefined })
      if (planSite.siteCode && asked.siteCode !== planSite.siteCode)
        throw invalidField("toothNumber", "El procedimiento conserva la pieza del tratamiento indicado")
      planSite = asked
      await tx
        .update(treatmentPlanItem)
        .set({ ...asked, updatedAt: new Date() })
        .where(and(eq(treatmentPlanItem.id, plan.id), eq(treatmentPlanItem.organizationId, orgId)))
    } else if (Object.keys(given).length > 0) {
      const asked = site.columns({ ...site.fields(planSite), ...given })
      if (!sameSite(asked, planSite))
        throw invalidField("toothNumber", "El procedimiento conserva el sitio del tratamiento indicado, sin cambios")
    }
    planScope = plan.scope
    planDiagnosis = plan.diagnosisCode
    planDiagnosisSystem = plan.diagnosisSystem
    planTitle = plan.title
    planServiceId = plan.serviceId
    planCodings = [...plan.codings]
    // Snapshot económico: la ejecución cobra lo acordado en la indicación.
    planPriceCents = plan.priceCents
    planCurrency = plan.currency
  }
  let serviceId: string | null = null
  let description = ""
  let scope: string | null = planScope
  let procedureSite: SiteColumns = planSite
  let codings = [...planCodings]
  // El costo nace con el acto: snapshot del tarifario o de la indicación; el
  // acto libre no tiene precio y nunca genera cargo.
  let priceCents: number | null = planPriceCents
  let currency: string | null = planCurrency
  if (serviceIdParam) {
    const service = await requireServiceForIndication(tx, orgId, serviceIdParam)
    if (!service.scope) throw validation("La prestación no tiene un ámbito válido")
    procedureSite = site.columns(siteInputOf(site, input), { scope: service.scope, surfaces: await surfaceLimits(tx, orgId, service) })
    serviceId = service.id
    description = service.name
    scope = service.scope
    // Oferta oficial: un único snapshot exacto con su versión; propia: [].
    codings = await resolveServiceCodings(tx, (await orgClinicalProfile(tx, orgId)).services, service)
    // El costo viaja con el acto desde el tarifario vigente.
    priceCents = service.priceCents
    currency = service.currency
  } else if (planItemIdParam) {
    serviceId = planServiceId
    description = planTitle
  } else {
    // Acto libre: solo descripción; sin servicio no hay tarifa ni cargo.
    description = freeDescription ?? ""
    procedureSite = site.columns(siteInputOf(site, input))
    priceCents = null
    currency = null
  }
  const quantity = input.quantity ?? 1
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99)
    throw invalidField("quantity", "La cantidad va de 1 a 99")
  if (planItemIdParam && quantity !== 1)
    throw invalidField("quantity", "El tratamiento del plan se registra por sesión: la cantidad es 1")
  // El cargo nace del acto: precio unitario × cantidad.
  if (priceCents !== null) priceCents *= quantity
  if (!description) throw invalidField("description", "Describe el acto libre o elige un servicio del catálogo")
  if (description.length > TEXT_LIMITS.procedureDescription) {
    throw invalidField("description", `Escribe como mucho ${TEXT_LIMITS.procedureDescription} caracteres.`)
  }
  // Sin indicar, el acto lleva el diagnóstico de su tratamiento, con su lista.
  // Se comprueba antes de escribir nada, para decir el rechazo junto al código.
  const diagnosis =
    input.diagnosisCode === undefined
      ? { diagnosisSystem: planDiagnosis ? planDiagnosisSystem : null, diagnosisCode: planDiagnosis }
      : await resolveOptionalDiagnosisCode(tx, orgId, { code: input.diagnosisCode, system: input.diagnosisSystem }, "diagnosisCode")
  // Tratamiento directo (un solo gesto): ejecutar un servicio sin indicación
  // previa crea la indicación implícita en el plan vigente, ya realizada y
  // aceptada en la misma atención.
  let directPlanItemId: string | null = null
  /** Sus sesiones previstas: las habituales de su servicio (ADR 0164). */
  let directPlannedSessions = 1
  if (serviceIdParam) {
    const planId = await getOrCreateDirectPlan(tx, orgId, actorUserId, patientId, encounterId)
    const indicated = await addPlanItem(tx, orgId, actorUserId, patientId, {
      serviceId: serviceIdParam,
      planId,
      sourceEncounterId: encounterId,
      ...site.fields(procedureSite),
      diagnosisCode: input.diagnosisCode ?? null,
      diagnosisSystem: input.diagnosisSystem ?? null,
      odontogramEntryId: input.odontogramEntryId ?? null,
    })
    directPlanItemId = indicated.id
    directPlannedSessions = indicated.plannedSessions
    if (quantity > 1 && indicated.priceCents !== null) {
      // La indicación implícita refleja lo realizado: todas las unidades.
      await tx
        .update(treatmentPlanItem)
        .set({ priceCents: indicated.priceCents * quantity, updatedAt: new Date() })
        .where(eq(treatmentPlanItem.id, indicated.id))
    }
  }
  const [row] = await tx
    .insert(encounterProcedure)
    .values({
      organizationId: orgId,
      encounterId,
      serviceId,
      scope,
      ...procedureSite,
      description,
      quantity,
      ...diagnosis,
      planItemId: planItemIdParam ?? directPlanItemId,
      priceCents,
      currency,
      codings,
      createdBy: actorUserId,
    })
    .returning()
  if (procedureSite.siteSystem && procedureSite.siteCode && site.value(procedureSite.siteCode) !== null) {
    // El sitio suelto tratado (odentIA: la pieza) entra al set de la atención
    // para que el filtro de la historia lo incluya aunque no estuviera al abrirla.
    await tx
      .insert(encounterSite)
      .values({ organizationId: orgId, encounterId, siteSystem: procedureSite.siteSystem, siteCode: procedureSite.siteCode })
      .onConflictDoNothing({ target: [encounterSite.encounterId, encounterSite.siteSystem, encounterSite.siteCode] })
  }
  if (planItemIdParam) {
    // Conserva el vínculo encounter_plan_item (pudo crearse al abrir la
    // atención); setPlanItemStatus valida pertenencia mismo paciente/org +
    // borrador y exige decisión aceptada. El lock del encounter ya está tomado
    // en esta tx (re-lock es no-op).
    await tx
      .insert(encounterPlanItem)
      .values({ organizationId: orgId, encounterId, planItemId: planItemIdParam })
      .onConflictDoNothing({
        target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId],
      })
    const [item] = await tx
      .select({ status: treatmentPlanItem.status })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, planItemIdParam),
          eq(treatmentPlanItem.organizationId, orgId),
        ),
      )
    if (acceptedNow) {
      // Lo hizo, así que lo aceptó: ya no espera en el borrador. Con una sesión
      // prevista se cierra como el servicio directo. Con más (una endodoncia en
      // dos), queda en curso como cualquier tratamiento aceptado: la sesión
      // siguiente es del mismo tratamiento, se cobra una vez y se cierra con
      // «Completar» (QA del 6 nov: se cerraba en la primera y se cobraba otra vez).
      if (draftBudgetId) await removeBudgetItems(tx, orgId, actorUserId, patientId, draftBudgetId, { itemIds: [planItemIdParam] })
      const now = new Date()
      const done = acceptedPlannedSessions <= 1
      await tx
        .update(treatmentPlanItem)
        .set({
          status: done ? "realizado" : "en_curso",
          decisionStatus: "aceptado",
          decisionNote: "Aceptado al hacerlo en la atención",
          decidedAt: now,
          startedAt: now,
          completedAt: done ? now : null,
          updatedAt: now,
        })
        .where(and(eq(treatmentPlanItem.id, planItemIdParam), eq(treatmentPlanItem.organizationId, orgId)))
      await audit(tx, orgId, actorUserId, "plan.item_accepted_when_done", "treatment_plan_item", planItemIdParam, {
        patientId,
        encounterId,
        procedureId: row.id,
        plannedSessions: acceptedPlannedSessions,
      })
      if (done) {
        await (await productHooks(tx, orgId)).treatmentDone(tx, { orgId, actorUserId, patientId, encounterId, planItemId: planItemIdParam })
        await createFinishControls(tx, { orgId, actorUserId, patientId, encounterId, planItemId: planItemIdParam })
      }
    } else if (item && (item.status === "pendiente" || item.status === "programado")) {
      await setPlanItemStatus(tx, orgId, actorUserId, patientId, planItemIdParam, {
        status: "en_curso",
        encounterId,
      })
    }
  }
  if (directPlanItemId) {
    // Tratamiento directo: la indicación implícita queda enlazada a la sesión
    // y se cierra como aceptada + realizada en la misma transacción. Si su
    // servicio suele llevar varias sesiones (ADR 0164), queda aceptada y en
    // curso con ellas, como lo aceptado al hacerlo: hoy fue la primera.
    await tx
      .insert(encounterPlanItem)
      .values({ organizationId: orgId, encounterId, planItemId: directPlanItemId })
      .onConflictDoNothing({
        target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId],
      })
    const now = new Date()
    const directDone = directPlannedSessions <= 1
    await tx
      .update(treatmentPlanItem)
      .set({
        status: directDone ? "realizado" : "en_curso",
        decisionStatus: "aceptado",
        decisionNote: directDone
          ? "Tratamiento directo: indicado y ejecutado en la misma atención"
          : "Tratamiento directo: indicado y empezado en la misma atención",
        decidedAt: now,
        startedAt: now,
        completedAt: directDone ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(treatmentPlanItem.id, directPlanItemId),
          eq(treatmentPlanItem.organizationId, orgId),
        ),
      )
    await audit(
      tx,
      orgId,
      actorUserId,
      directDone ? "plan.item_direct_completed" : "plan.item_direct_started",
      "treatment_plan_item",
      directPlanItemId,
      {
        patientId,
        encounterId,
        procedureId: row.id,
        plannedSessions: directPlannedSessions,
      },
    )
    // El servicio directo de una sesión nace realizado: lo que su producto hace con
    // un tratamiento realizado (odentIA: lo tratado queda dibujado). El de varias se
    // dibuja al terminarlo.
    if (directDone) {
      await (await productHooks(tx, orgId)).treatmentDone(tx, { orgId, actorUserId, patientId, encounterId, planItemId: directPlanItemId })
      await createFinishControls(tx, { orgId, actorUserId, patientId, encounterId, planItemId: directPlanItemId })
    }
  }
  await audit(tx, orgId, actorUserId, "encounter.procedure_added", "encounter_procedure", row.id, {
    patientId,
    encounterId,
    planItemId: input.planItemId ?? null,
  })
  return withSite(await siteOf(tx, orgId), row)
}

/**
 * Lo que ya se hizo de ese servicio en ese sitio: un tratamiento de la persona en
 * curso, o realizado en los últimos 60 días. Lo consulta «Registrar
 * procedimiento» antes de guardar un servicio directo, para no abrir otro
 * tratamiento ni cobrarlo completo otra vez cuando es su sesión siguiente (QA
 * del 6 nov: la sesión 2 de una endodoncia registrada como servicio se cobraba
 * de nuevo). Avisa y no bloquea; si está en curso, la pantalla avisa
 * que guardarlo lo une a él. `n` es la sesión que sería (hechas + 1).
 */
export interface EarlierTreatment {
  planItemId: string
  title: string
  status: "en_curso" | "realizado"
  /** Su última sesión vigente (o cuándo se completó, si no tiene). */
  lastDoneAt: Date
  n: number
  m: number
  /** El sitio del tratamiento, como lo dice el producto (odentIA: `toothNumber`). */
  site: SiteFields
}

/** Cuánto atrás se mira lo realizado del mismo servicio y sitio. */
const EARLIER_TREATMENT_DAYS = 60

export async function findEarlierTreatment(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  input: Pick<AddEncounterProcedureInput, "serviceId" | "toothNumber" | "surfaces" | "quadrant" | "arch">,
): Promise<EarlierTreatment | null> {
  await requirePatient(tx, orgId, patientId)
  await requireEncounter(tx, orgId, patientId, encounterId)
  const serviceId = input.serviceId?.trim()
  if (!serviceId) return null
  const siteCode = await requestedSiteCode(tx, orgId, input)
  const since = new Date(Date.now() - EARLIER_TREATMENT_DAYS * 86_400_000)
  const [found] = await tx
    .select({
      item: treatmentPlanItem,
      // Con la tabla escrita: dentro de una subconsulta, la columna sola sería ambigua.
      lastDoneAt: sql<Date | null>`(select max(done.created_at) from encounter_procedure done
        where done.organization_id = "treatment_plan_item"."organization_id" and done.plan_item_id = "treatment_plan_item"."id"
          and done.voided_at is null)`.mapWith((value) => (value ? new Date(value as string) : null)),
      done: sessionsDoneSql({ id: sql`"treatment_plan_item"."id"`, organizationId: sql`"treatment_plan_item"."organization_id"` }).mapWith(Number),
    })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.serviceId, serviceId),
        siteCode ? eq(treatmentPlanItem.siteCode, siteCode) : isNull(treatmentPlanItem.siteCode),
        or(
          eq(treatmentPlanItem.status, "en_curso"),
          // Lo realizado, si fue en un sitio (una pieza) o era de varias sesiones: una
          // consulta o un control sin sitio se repiten sin ser otra sesión.
          and(
            eq(treatmentPlanItem.status, "realizado"),
            gte(treatmentPlanItem.completedAt, since),
            or(isNotNull(treatmentPlanItem.siteCode), gt(treatmentPlanItem.plannedSessions, 1)),
          ),
        ),
      ),
    )
    // Lo que sigue en curso primero: es lo que se puede continuar.
    .orderBy(sql`${treatmentPlanItem.status} = 'en_curso' desc`, desc(treatmentPlanItem.updatedAt), desc(treatmentPlanItem.id))
    .limit(1)
  if (!found) return null
  const site = await siteOf(tx, orgId)
  const { item } = found
  return {
    planItemId: item.id,
    title: item.title,
    status: item.status === "en_curso" ? "en_curso" : "realizado",
    lastDoneAt: found.lastDoneAt ?? item.completedAt ?? item.updatedAt,
    n: found.done + 1,
    m: item.plannedSessions,
    site: site.fields(item),
  }
}

/** Cargo omitido al cerrar: queda registrado para mostrarlo en el resumen. */
export interface SkippedCharge {
  procedureId: string
  /** `returned`: lo cobrado de su tratamiento se devolvió todo y no se vuelve a cobrar solo (ADR 0068). */
  reason: "covered" | "free_act" | "zero_price" | "sessions_complete" | "returned"
}

/** Línea del diálogo de cierre: qué quedó por cobrar y qué no. */
export interface FinalizeBillingLine {
  procedureId: string
  description: string
  amountCents: number | null
  currency: string | null
  status: "charged" | "skipped"
  reason: SkippedCharge["reason"] | null
  /**
   * Con un adelanto «Para» este tratamiento: lo acordado entero y lo ya cargado como adelanto. El
   * cierre dice «Costó 900 · 300 de adelanto» junto a los 600 de hoy (QA del 10 nov, M7).
   */
  agreedCents?: number
  advanceCents?: number
}

/** Lo que llegaba a sus sesiones previstas y la firma no pudo terminar: sigue en curso. */
export interface SessionKeptOpen {
  planItemId: string
  title: string
  /** Por qué no se pudo (el mensaje del servicio). */
  reason: string
}

/** Lo que informa el cierre; el producto agrega lo suyo (odentIA: el odontograma que firmó). */
export type FinalizeEncounterResult = FinalizeEncounterBase & ProductParts

export interface FinalizeEncounterBase {
  encounter: EncounterRow
  /** Lo que se iba a terminar al firmar (ADR 0161) y quedó en curso, con su motivo. */
  keptOpen: SessionKeptOpen[]
  /**
   * Lo que va después de lo que sigue en curso y ya tiene su cita (la corona reservada mientras la
   * endodoncia pide otra sesión): el cierre lo avisa para revisar esa cita (repaso del 9 nov).
   */
  bookedAfter: BookedAfter[]
  /**
   * Lo aceptado de la misma pieza que va después de lo que sigue en curso y aún no tiene cita (la
   * corona mientras la endodoncia pide la sesión 2): «Atención finalizada» lo dice para que no se
   * pierda, sin ofrecer reservarlo todavía (pendiente de la entrega 8).
   */
  waitingAfter: Array<{ planItemId: string; title: string; place?: string; beforeTitle: string }>
  /**
   * Lo trabajado hoy que sigue en curso, con su próxima sesión: la cita que ya la
   * lleva o la que falta reservar. «Atención finalizada» ofrece reservarla ahí mismo.
   */
  nextSessions: NextSession[]
  /**
   * Las citas por venir que se reservaron para lo que hoy quedó hecho (la sesión 2 hecha antes):
   * «Atención finalizada» ofrece liberarlas o usarlas para lo que sigue (QA del 10 nov, M1).
   */
  freedAppointments: FreedAppointment[]
  /** Cargos generados automáticamente desde los actos con servicio. */
  charges: Array<typeof patientCharge.$inferSelect>
  skippedCharges: SkippedCharge[]
  /**
   * Resumen para el diálogo de cierre y caja: un total por moneda. `chargedCents` y
   * `currency` son los de la única moneda; con dos, `chargedCents` es nulo.
   */
  billing: {
    chargedCents: number | null
    currency: string | null
    totals: Array<{ currency: string; totalCents: number }>
    lines: FinalizeBillingLine[]
  }
  /**
   * El presupuesto que quedó armado con lo indicado en esta atención (decisión
   * 12): el cierre pregunta «¿Enviárselo ahora?». Nulo si no entró nada.
   */
  budget: AssembledBudget | null
  /**
   * Los materiales que descontó el cierre (ADR 0067), con lo que quedó como
   * faltante. Null si la atención no tiene sede o no usó nada configurado.
   */
  materials: DiscountedMaterials | null
  /**
   * Lo que el cierre hizo con los controles (ADR 0152): el que indicó
   * «¿Cuándo vuelve?» y los que esta visita cumplió.
   */
  controls: {
    /**
     * El control indicado al firmar. `joinsNext`: va en la misma cita que lo aceptado que se ofrece
     * reservar (la corona con el control de su endodoncia, `pairsWithAccepted`), desde `from`
     * (`YYYY-MM-DD`, el día en que abre su ventana), como en «Qué sigue».
     */
    next: { id: string; title: string; dueAt: Date; joinsNext?: { from: string } } | null
    fulfilled: Array<{ id: string; title: string }>
    /** «En 1 semana» para lo que falta hacer, sin control aparte. */
    returnsTo: { day: string; titles: string[] } | null
  }
}

/** Aviso en vivo (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notifyClose(tx: Db, orgId: string, kind: string): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind, at: new Date().toISOString() })})`)
}

/**
 * Línea aceptada vigente de un tratamiento (presupuesto aceptado/parcial con
 * decisión aceptada): trae precio final acordado y modo de cobro congelados.
 * La regla es una sola, la que también dice el precio en pantalla (`agreed-lines.ts`).
 */
async function acceptedBudgetLine(
  tx: Db,
  orgId: string,
  patientId: string,
  planItemId: string,
): Promise<typeof treatmentBudgetItem.$inferSelect | null> {
  return (await acceptedBudgetLines(tx, orgId, patientId, [planItemId])).get(planItemId) ?? null
}

/** Lo que falta para cerrar una atención, en el orden de la historia clínica. */
export type ClosingRequirement = "reason" | "diagnosis" | "evolution" | "signature"

/**
 * «¿Se puede cerrar?». El producto agrega lo suyo, que informa y no bloquea
 * (odentIA: el odontograma que se firmará y el periodontograma).
 */
export type ClosingCheck = ClosingCheckBase & ProductParts

export interface ClosingCheckBase {
  ready: boolean
  missing: ClosingRequirement[]
  /**
   * Consentimientos que pide la atención y no están firmados (pendientes, sin
   * preparar o sin publicar). No bloquean (decisión 3): cerrar sin ellos pide
   * decir por qué.
   */
  consents: ConsentNeed[]
  /**
   * Lo que se descontará al firmar (materiales de sus servicios × cantidad),
   * por producto y con la sede. Informa, no pide confirmar; null si la
   * atención no tiene sede o no hay nada que descontar.
   */
  materials: ClosingMaterials | null
  /**
   * Lo que falta saber de su salud (enfermedades o medicación sin preguntar,
   * ASA sin clasificar) y los anestésicos locales que se descontarán: con
   * anestesia y algo por saber, el cierre lo avisa junto a los materiales. No
   * bloquea; la firma deja constancia de que se firmó así.
   */
  health: { gaps: HealthGap[]; anesthetics: string[] }
  /** «¿Cuándo vuelve?» y los controles que esta visita cumple (ADR 0152). */
  controls: ClosingControls
  /**
   * Lo trabajado hoy de un tratamiento abierto. `finishing`: con esta atención
   * llega a sus sesiones previstas, o las pasa; el cierre pregunta «¿Terminaste?»
   * con «Sí, terminar» ya elegido, y firmar sin cambiarlo lo termina (ADR 0161).
   * `continuing`: le faltan sesiones y queda en curso. `n` cuenta esta atención; `m`, las previstas.
   * `notRegistered`: lo que traía la cita y hoy no tiene sesión registrada; el
   * cierre lo avisa sin frenar la firma (`n` es la sesión que le tocaba).
   */
  sessions: {
    finishing: ClosingSession[]
    continuing: ClosingSession[]
    notRegistered: ClosingSession[]
    /** Lo aceptado sin empezar, a lo que vuelve (`n` = 0: aún no tiene ninguna sesión). */
    accepted: ClosingSession[]
  }
  /**
   * Los diagnósticos activos que resuelve un tratamiento trabajado hoy si queda
   * realizado (la pulpitis de la 46 con su endodoncia): el cierre los propone
   * marcados y se resuelven los que vuelven en `resolveDiagnosisIds` (QA del 9 nov).
   */
  resolvable: ClosingResolvable[]
  /**
   * Los formularios de la atención que siguen a medias. No bloquean: el cierre
   * lo avisa y se terminan después de firmar, con su propia fecha.
   */
  openForms: Array<{ id: string; title: string }>
}

/** Un tratamiento trabajado en la atención, con su sesión: «Endodoncia · sesión 2 de 2». */
export interface ClosingSession {
  planItemId: string
  title: string
  n: number
  m: number
  /** Dónde, si no se hizo hoy («pieza 46»): lo aceptado sin empezar no está en la atención. */
  place?: string
  /**
   * La cita por venir que ya lleva su próxima sesión: «la sesión 2 tiene cita el
   * lun 9, 10:45» (QA del 8 nov, X11). Sin cita, no viene.
   */
  booked?: BookedSession
}

/** Una cita por venir que lleva la próxima sesión de un tratamiento, con la sesión que será. */
export interface BookedSession {
  appointmentId: string
  startsAt: Date
  /** Con quién es: «Atención finalizada» lo dice junto a la hora (QA del 8 nov). */
  professionalUserId: string
  n: number
  m: number
}

/**
 * La próxima sesión de un tratamiento que sigue en curso (propuesta 2 de la QA
 * del 8 nov): la cita que ya la lleva o, si no tiene, la que falta reservar. Solo
 * la próxima: con la sesión 2 reservada no se ofrece reservar la 3.
 */
export interface NextSession {
  planItemId: string
  title: string
  /** Con qué servicio se abre «Nueva cita». */
  serviceId: string | null
  booked: BookedSession | null
  /**
   * La sesión que falta reservar (`canBookAnother`), con las previstas; nula si ya tiene cita o no
   * le falta. `from`: desde qué día conviene (`nextSessionFromOf`), si no es mañana.
   */
  toBook: { n: number; m: number; from?: string; gapDays?: number } | null
}

/** Lo aceptado que va después de otro tratamiento sin terminar y ya tiene su cita. */
export interface BookedAfter {
  planItemId: string
  title: string
  /** Lo que va antes y sigue en curso. */
  beforeTitle: string
  startsAt: Date
  professionalName: string | null
}

/**
 * De lo que sigue en curso (`beforeIds`), lo que va después (`goesBeforeSql`) y ya tiene una cita
 * por venir antes de la próxima sesión de lo de antes (o sin ella): la primera de cada uno.
 */
export async function bookedAfterOf(
  tx: Db,
  orgId: string,
  beforeIds: readonly string[],
): Promise<BookedAfter[]> {
  if (beforeIds.length === 0) return []
  const { planPhases } = await productHooks(tx, orgId)
  const later = planItemSql("later")
  const rows = await tx.execute<{
    id: string
    title: string
    before_title: string
    starts_at: Date | string
    professional_name: string | null
  }>(sql`
    select distinct on (later.id) later.id, later.title, before_item.title as before_title, a.starts_at, u.name as professional_name
    from treatment_plan_item later
    join treatment_plan_item before_item on ${goesBeforeSql(later, planItemSql("before_item"), planPhases)}
    join appointment_plan_item carried on carried.organization_id = later.organization_id and carried.plan_item_id = later.id
    join appointment a on a.organization_id = carried.organization_id and a.id = carried.appointment_id
      and a.status in (${sql.join(
        LIVE_APPOINTMENT_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )}) and a.starts_at > now()
    left join "user" u on u.id = a.professional_user_id
    where later.organization_id = ${orgId} and later.decision_status = 'aceptado'
      and before_item.id in (${sql.join(
        beforeIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      -- Si su próxima sesión ya tiene cita antes (o en la misma cita), no hay nada que revisar.
      and not exists (select 1 from appointment_plan_item next_session
        join appointment b on b.organization_id = next_session.organization_id and b.id = next_session.appointment_id
        where next_session.organization_id = before_item.organization_id and next_session.plan_item_id = before_item.id
          and b.status in (${sql.join(
            LIVE_APPOINTMENT_STATUSES.map((status) => sql`${status}`),
            sql`, `,
          )})
          and b.starts_at > now() and b.starts_at <= a.starts_at)
    order by later.id, a.starts_at`)
  return rows.map((row) => ({
    planItemId: row.id,
    title: row.title,
    beforeTitle: row.before_title,
    startsAt: new Date(row.starts_at),
    professionalName: row.professional_name,
  }))
}

/**
 * La próxima sesión de cada tratamiento aceptado y por hacer de `itemIds`, en el
 * orden del plan; los que no tienen cita ni sesión por reservar no vienen. Cuenta con las
 * reglas de `to-schedule.ts` (`sessionCountsOf`, `canBookAnother`) y la sesión de
 * la cita con la de la agenda (`appointmentSessionsOf`). `exceptAppointmentId` es
 * la cita de la atención que se está cerrando: no es la próxima.
 */
export async function nextSessionsOf(
  tx: Db,
  orgId: string,
  itemIds: readonly string[],
  exceptAppointmentId: string | null,
): Promise<NextSession[]> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return []
  const items = await tx
    .select({
      id: treatmentPlanItem.id,
      title: treatmentPlanItem.title,
      serviceId: treatmentPlanItem.serviceId,
      status: treatmentPlanItem.status,
      decisionStatus: treatmentPlanItem.decisionStatus,
      plannedSessions: treatmentPlanItem.plannedSessions,
    })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        inArray(treatmentPlanItem.id, ids),
        eq(treatmentPlanItem.decisionStatus, "aceptado"),
        inArray(treatmentPlanItem.status, [...TO_SCHEDULE_STATUSES]),
      ),
    )
    // En el orden del plan, antes y después de firmar: el primero pone el servicio de «Nueva cita».
    .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  if (items.length === 0) return []
  const counts = await sessionCountsOf(tx, orgId, items.map((item) => item.id))
  // La primera cita por venir que lleva cada uno (la regla de «una cita por venir lo lleva»).
  const upcoming = await tx
    .select({
      planItemId: appointmentPlanItem.planItemId,
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
      professionalUserId: appointment.professionalUserId,
    })
    .from(appointmentPlanItem)
    .innerJoin(
      appointment,
      and(eq(appointment.organizationId, appointmentPlanItem.organizationId), eq(appointment.id, appointmentPlanItem.appointmentId)),
    )
    .where(
      and(
        eq(appointmentPlanItem.organizationId, orgId),
        inArray(appointmentPlanItem.planItemId, items.map((item) => item.id)),
        inArray(appointment.status, [...LIVE_APPOINTMENT_STATUSES]),
        // El mismo «ahora» que las citas en pie de `sessionCountsOf`.
        sql`${appointment.startsAt} > now()`,
        exceptAppointmentId ? ne(appointment.id, exceptAppointmentId) : undefined,
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
  const firstOf = new Map<string, { appointmentId: string; startsAt: Date; professionalUserId: string }>()
  for (const row of upcoming) {
    if (!firstOf.has(row.planItemId))
      firstOf.set(row.planItemId, { appointmentId: row.appointmentId, startsAt: row.startsAt, professionalUserId: row.professionalUserId })
  }
  const sessionsOf = await appointmentSessionsOf(tx, orgId, [...new Set([...firstOf.values()].map((row) => row.appointmentId))])
  const fromOf = await nextSessionGapOf(tx, orgId, items.filter((item) => !firstOf.has(item.id)).map((item) => item.id))
  const out: NextSession[] = []
  for (const item of items) {
    const id = item.id
    const count = counts.get(id) ?? { done: 0, booked: 0 }
    const first = firstOf.get(id)
    const session = first ? sessionsOf.get(first.appointmentId)?.find((row) => row.planItemId === id) : undefined
    const booked = first ? { ...first, n: session?.n ?? count.done + 1, m: session?.m ?? item.plannedSessions } : null
    const from = fromOf.get(id)
    const toBook =
      !booked && canBookAnother(item, count)
        ? {
            n: count.done + count.booked + 1,
            m: item.plannedSessions,
            ...(from ? { from: from.from, gapDays: from.days } : {}),
          }
        : null
    if (booked || toBook) out.push({ planItemId: id, title: item.title, serviceId: item.serviceId, booked, toBook })
  }
  return out
}

/**
 * Los tratamientos abiertos con un procedimiento vigente en esta atención, y en
 * qué sesión quedan con ella (la regla de `sessionsDoneSql`).
 */
async function closingSessionsOf(
  tx: Db,
  orgId: string,
  encounterId: string,
  appointmentId: string | null,
): Promise<ClosingCheckBase["sessions"]> {
  const rows = await tx.execute<{ id: string; title: string; m: number; done: number }>(sql`
    select worked.id, worked.title, worked.planned_sessions as m,
      ${sessionsDoneSql({ id: sql`worked.id`, organizationId: sql`worked.organization_id` })} as done
    from treatment_plan_item worked
    where worked.organization_id = ${orgId}
      and worked.status in ('pendiente', 'programado', 'en_curso')
      and exists (select 1 from encounter_procedure today
        where today.organization_id = worked.organization_id and today.plan_item_id = worked.id
          and today.encounter_id = ${encounterId} and today.voided_at is null)
    order by worked.sort_order, worked.created_at, worked.id`)
  const finishing: ClosingSession[] = []
  const continuing: ClosingSession[] = []
  // Si la próxima sesión ya tiene cita, el cierre la dice (QA del 8 nov, X11).
  const next = new Map(
    (await nextSessionsOf(tx, orgId, rows.map((row) => row.id), appointmentId)).map((session) => [session.planItemId, session.booked]),
  )
  for (const row of rows) {
    const booked = next.get(row.id)
    const session: ClosingSession = { planItemId: row.id, title: row.title, n: Number(row.done), m: Number(row.m), ...(booked ? { booked } : {}) }
    ;(session.n >= session.m ? finishing : continuing).push(session)
  }
  // Lo que la cita traía, o se trajo al empezar («Hacerla hoy»), y hoy no se
  // registró: la sesión que le tocaba. Con o sin cita: el cierre lo avisa sin frenar.
  const notRegistered: ClosingSession[] = []
  const carried = await tx.execute<{ id: string; title: string; m: number; done: number }>(sql`
    select carried.id, carried.title, carried.planned_sessions as m,
      ${sessionsDoneSql({ id: sql`carried.id`, organizationId: sql`carried.organization_id` })} as done
    from treatment_plan_item carried
    where carried.organization_id = ${orgId}
      and carried.decision_status = 'aceptado' and carried.status in ('pendiente', 'programado', 'en_curso')
      and (exists (select 1 from encounter_plan_item linked
            where linked.organization_id = carried.organization_id and linked.plan_item_id = carried.id
              and linked.encounter_id = ${encounterId})
        ${
          appointmentId
            ? sql`or exists (select 1 from appointment_plan_item brought
            where brought.organization_id = carried.organization_id and brought.plan_item_id = carried.id
              and brought.appointment_id = ${appointmentId})`
            : sql``
        })
      and not exists (select 1 from encounter_procedure today
        where today.organization_id = carried.organization_id and today.plan_item_id = carried.id
          and today.encounter_id = ${encounterId} and today.voided_at is null)
    order by carried.sort_order, carried.created_at, carried.id`)
  for (const row of carried)
    notRegistered.push({
      planItemId: row.id,
      title: row.title,
      n: Number(row.done) + 1,
      m: Number(row.m),
    })
  // Lo aceptado que aún no empieza en la misma pieza que lo que hoy se trabajó (la corona tras
  // la endodoncia de la 46): es a lo que vuelve. «¿Cuándo vuelve?» lo dice y «Atención finalizada»
  // lo reserva, en vez de un control genérico que pedía otra cita (QA del 9 nov). No si otro
  // tratamiento sigue en curso sin su sesión de hoy (la sesión 2 de otra endodoncia va primero), ni
  // lo de otra pieza o sin pieza (un blanqueamiento aceptado hace un año no cambia cada cierre).
  // Los de hoy y los que trae la cita ya están arriba.
  const taken = new Set([...finishing, ...continuing, ...notRegistered].map((session) => session.planItemId))
  const pendingRows = await tx.execute<{
    id: string
    title: string
    m: number
    site_system: string | null
    site_code: string | null
    site_qualifiers: string[] | null
  }>(sql`
    select waiting.id, waiting.title, waiting.planned_sessions as m,
      waiting.site_system, waiting.site_code, waiting.site_qualifiers
    from treatment_plan_item waiting
    join encounter here on here.organization_id = waiting.organization_id and here.id = ${encounterId}
    where waiting.organization_id = ${orgId} and waiting.patient_id = here.patient_id
      and waiting.decision_status = 'aceptado' and waiting.status in ('pendiente', 'programado')
      and waiting.site_code is not null
      and not exists (select 1 from encounter_procedure done
        where done.organization_id = waiting.organization_id and done.plan_item_id = waiting.id and done.voided_at is null)
      and exists (select 1 from encounter_procedure today
        join treatment_plan_item worked on worked.organization_id = today.organization_id and worked.id = today.plan_item_id
        where today.organization_id = waiting.organization_id and today.encounter_id = here.id and today.voided_at is null
          and worked.site_system is not distinct from waiting.site_system and worked.site_code = waiting.site_code)
      and not exists (select 1 from treatment_plan_item other
        where other.organization_id = waiting.organization_id and other.patient_id = waiting.patient_id
          and other.status = 'en_curso'
          and not exists (select 1 from encounter_procedure other_today
            where other_today.organization_id = other.organization_id and other_today.plan_item_id = other.id
              and other_today.encounter_id = here.id and other_today.voided_at is null))
    order by waiting.sort_order, waiting.created_at, waiting.id
    limit 6`)
  const site = await siteOf(tx, orgId)
  const pendingIds = pendingRows.filter((row) => !taken.has(row.id)).slice(0, 3)
  const bookedPending = new Map(
    (await nextSessionsOf(tx, orgId, pendingIds.map((row) => row.id), appointmentId)).map((session) => [session.planItemId, session.booked]),
  )
  const accepted: ClosingSession[] = pendingIds.map((row) => {
    const booked = bookedPending.get(row.id)
    const place = site.words({ siteSystem: row.site_system, siteCode: row.site_code, siteQualifiers: row.site_qualifiers ?? [] }, "short")
    return { planItemId: row.id, title: row.title, n: 0, m: Number(row.m), ...(place ? { place } : {}), ...(booked ? { booked } : {}) }
  })
  return { finishing, continuing, notRegistered, accepted }
}

/** Un control pendiente cuya ventana ya abrió: esta visita lo cumple al firmar (ADR 0152). */
export interface ClosingDueControl {
  id: string
  title: string
  kind: string
  dueAt: Date
  /** Quien firma es quien atendió la atención donde se indicó: viene marcado. */
  mine: boolean
  /** Quien atiende dijo al empezar que viene a este control («Viene a su control»): también viene marcado. */
  chosen: boolean
  /** Quien lo indicó (la atención de origen), para decir «de la Dra. Ana». */
  originProfessionalUserId: string | null
  /** Si se repite, cumplirlo deja indicado el siguiente. */
  repeatEveryMonths: number | null
}

/** El próximo control que ya tiene la persona (o la atención): no se pregunta «¿Cuándo vuelve?». */
export interface ClosingNextControl {
  id: string
  title: string
  dueAt: Date
  status: string
  /** La hora de su cita, si está reservado. */
  scheduledAt: Date | null
  /** Se indicó en esta misma atención. */
  own: boolean
}

/** Un control reservado en la cita de esta atención: se cumple al firmarla (`closeAppointment`). */
export interface ClosingAppointmentControl {
  id: string
  title: string
  repeatEveryMonths: number | null
  /** Quien lo indicó, si no es quien atiende hoy. */
  byName: string | null
}

export interface ClosingControls {
  /** Los meses de «En N meses»: los del producto (6 en odentIA, 12 en latidIA). */
  recallMonths: number
  /** Los controles que cumple la cita de esta atención: no son «el próximo». */
  byAppointment: ClosingAppointmentControl[]
  /** Los días civiles de cada atajo, en la zona de la clínica: lo que se manda en `nextControl.dueAt`. */
  shortcuts: { week: string; month: string; recall: string }
  due: ClosingDueControl[]
  next: ClosingNextControl | null
  /**
   * Los controles que dejan los tratamientos que terminan al firmar (B5 del 10 nov), por su
   * servicio: el cierre los muestra y quien firma los cambia o los quita para esta persona
   * (`FinalizeEncounterInput.finishControlChanges`).
   */
  finishing: FinishingControl[]
  /** Los controles que ya tiene abiertos (sin el de la cita de hoy): lo que va a quedar. */
  open: ClosingOpenControl[]
  /**
   * Lo que falta hacer y no tiene cita (lo aceptado, o lo indicado hoy), cuando hoy no se hizo
   * nada: «¿Cuándo vuelve? En 1 semana» es para eso, no un control de mantenimiento aparte (QA del
   * 10 nov, M6 y B7). Firmar con una fecha no crea el control: lo que sigue es reservarlo.
   */
  returnsTo: string[]
}

/** Un control abierto de la persona, como lo dice el cierre: pendiente o con su cita. */
export interface ClosingOpenControl {
  id: string
  title: string
  dueAt: Date
  status: string
  /** La hora de su cita, si la tiene en pie: se cambia moviendo la cita. */
  scheduledAt: Date | null
}

const CLOSING_MESSAGES: Record<ClosingRequirement, string> = {
  reason: "el motivo de consulta",
  diagnosis: "al menos un diagnóstico con su tipo (presuntivo basta)",
  evolution: "la evolución",
  signature: "tu colegiatura en el perfil profesional",
}

/**
 * Mínimo para cerrar (ADR 0003 y 0041): motivo, un diagnóstico de la lista con
 * su tipo («Presuntivo» basta),
 * evolución y firma con colegiatura. Funciones vitales y pronóstico quedan
 * opcionales (los exámenes auxiliares son órdenes de la atención): documentar
 * una consulta no obliga a inventar.
 */
export async function checkEncounterClosing(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: EncounterRow,
  /** «Falta otra sesión» ya elegido en pantalla: no se cuenta como terminado al anunciar lo que se firma. */
  keepOpenPlanItemIds: readonly string[] = [],
): Promise<ClosingCheck> {
  const missing: ClosingRequirement[] = []
  if (!row.reason?.trim()) missing.push("reason")
  const [diagnosis] = await tx
    .select({ id: encounterDiagnosis.id })
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, row.id),
        isNull(encounterDiagnosis.voidedAt),
        isNotNull(encounterDiagnosis.diagnosisType),
      ),
    )
    .limit(1)
  if (!diagnosis) missing.push("diagnosis")
  if (!row.evolution?.trim()) missing.push("evolution")
  try {
    await requireProfessionalSignature(tx, orgId, actorUserId)
  } catch (e) {
    // Sin perfil completo, o quien atiende ya no es miembro: no puede firmar.
    if (!(e instanceof ServiceError) || (e.code !== "PROFILE_INCOMPLETE" && e.status !== 404))
      throw e
    missing.push("signature")
  }
  // Solo lo de lo que se hizo hoy: lo indicado o traído para otro día se firma cuando se haga.
  const consents = (await getEncounterConsentNeeds(tx, orgId, row.patientId, row.id)).filter(
    (need) => need.status !== "firmado" && need.doneToday,
  )
  const materials = await closingMaterialsOf(tx, orgId, row)
  const health = {
    gaps: await healthGapsOf(tx, orgId, row.patientId),
    anesthetics: (materials?.items ?? []).filter((item) => isLocalAnestheticName(item.name)).map((item) => item.name),
  }
  const sessions = await closingSessionsOf(tx, orgId, row.id, row.appointmentId ?? null)
  const resolvable = await resolvableDiagnosesOf(tx, orgId, row.patientId, row.id)
  const openForms = await listOpenEncounterForms(tx, orgId, row.id)
  // Lo que ya terminó en esta atención (lo de una sesión al registrarlo, «Completar») ya dejó su
  // control: se muestra con lo que termina al firmar, para cambiarlo o quitarlo igual (QA antes de
  // entregar); no como uno que ya tenía.
  const doneToday = await tx.execute<{ id: string; plan_item_id: string }>(sql`
    select f.id, link.plan_item_id from clinical_follow_up f
    join clinical_follow_up_item link on link.organization_id = f.organization_id and link.follow_up_id = f.id
    join encounter_procedure today on today.organization_id = link.organization_id and today.plan_item_id = link.plan_item_id
      and today.encounter_id = ${row.id} and today.voided_at is null
    where f.organization_id = ${orgId} and f.patient_id = ${row.patientId}
      and f.finish_after_days is not null and f.status = 'pendiente'`)
  const fromToday = new Set(doneToday.map((link) => link.id))
  const base = await closingControlsOf(tx, orgId, actorUserId, row)
  const controls = {
    ...base,
    open: base.open.filter((control) => !fromToday.has(control.id)),
    finishing: await finishingControlsOf(tx, orgId, [
      ...new Set([
        ...sessions.finishing.map((session) => session.planItemId).filter((id) => !keepOpenPlanItemIds.includes(id)),
        ...doneToday.map((link) => link.plan_item_id),
      ]),
    ]),
  }
  const product = await (await productHooks(tx, orgId)).closingParts(tx, {
    orgId,
    patientId: row.patientId,
    encounterId: row.id,
    finishingPlanItemIds: sessions.finishing
      .map((session) => session.planItemId)
      .filter((id) => !keepOpenPlanItemIds.includes(id)),
  })
  return { ready: missing.length === 0, missing, consents, materials, health, sessions, resolvable, openForms, controls, ...product }
}

/** Un día civil («2026-11-07») más N meses; el 31 cae en el último día del mes que no lo tiene. */
function addMonthsToDay(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const total = month - 1 + months
  const y = year + Math.floor(total / 12)
  const m = ((total % 12) + 12) % 12
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`
}

function addDaysToDay(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10)
}

/** Los controles por cumplir de la persona: pendientes, con su ventana abierta y no indicados en esta atención. */
export async function dueControlsOf(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: EncounterRow,
  timezone: string,
): Promise<ClosingDueControl[]> {
  // Los que llevaba la cita y soltó «Vino» (recepción la cerró antes): esta atención es esa
  // visita, así que vienen marcados aunque su ventana no esté abierta; quien firma decide.
  const cameReleased = row.appointmentId
    ? (
        await tx.execute<{ id: string }>(sql`
          select distinct e.entity_id as id from audit_event e
          where e.organization_id = ${orgId} and e.entity = 'clinical_follow_up' and e.action = 'follow_up.unscheduled'
            and e.metadata->>'appointmentId' = ${row.appointmentId} and e.metadata->>'by' = 'vino'`)
      ).map((found) => found.id)
    : []
  const rows = await tx
    .select({
      id: clinicalFollowUp.id,
      title: clinicalFollowUp.title,
      kind: clinicalFollowUp.kind,
      dueAt: clinicalFollowUp.dueAt,
      repeatEveryMonths: clinicalFollowUp.repeatEveryMonths,
      originProfessional: encounter.professionalUserId,
    })
    .from(clinicalFollowUp)
    .leftJoin(
      encounter,
      and(eq(encounter.id, clinicalFollowUp.originEncounterId), eq(encounter.organizationId, clinicalFollowUp.organizationId)),
    )
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, row.patientId),
        eq(clinicalFollowUp.status, "pendiente"),
        sql`${clinicalFollowUp.originEncounterId} is distinct from ${row.id}`,
        cameReleased.length > 0
          ? or(
              controlWindowOpenSql({ dueAt: clinicalFollowUp.dueAt, createdAt: clinicalFollowUp.createdAt }, timezone),
              inArray(clinicalFollowUp.id, cameReleased),
            )
          : controlWindowOpenSql({ dueAt: clinicalFollowUp.dueAt, createdAt: clinicalFollowUp.createdAt }, timezone),
      ),
    )
    .orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
  return rows.map(({ originProfessional, ...control }) => ({
    ...control,
    mine: originProfessional === actorUserId,
    chosen: row.visitFollowUpId === control.id || cameReleased.includes(control.id),
    originProfessionalUserId: originProfessional ?? null,
  }))
}

/** El más tardío de dos días «YYYY-MM-DD». */
function notBefore(day: string, earliest: string): string {
  return day < earliest ? earliest : day
}

/**
 * «¿Cuándo vuelve?» al firmar (ADR 0152): los atajos en días de la clínica,
 * los controles que esta visita cumple y el próximo que ya tiene la persona
 * (pendiente o reservado, también el indicado aquí). Con uno así no se
 * pregunta: no se crean dos.
 */
async function closingControlsOf(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: EncounterRow,
): Promise<Omit<ClosingControls, "finishing">> {
  const { timezone } = await findOrgLocale(tx, orgId)
  const { recallMonths } = await productHooks(tx, orgId)
  const today = dayKeyIn(new Date(), timezone)
  const visitDay = dayKeyIn(row.startedAt, timezone) < today ? dayKeyIn(row.startedAt, timezone) : today
  const due = await dueControlsOf(tx, orgId, actorUserId, row, timezone)
  const dueIds = new Set(due.map((control) => control.id))
  const open = await tx
    .select({
      id: clinicalFollowUp.id,
      title: clinicalFollowUp.title,
      dueAt: clinicalFollowUp.dueAt,
      status: clinicalFollowUp.status,
      originEncounterId: clinicalFollowUp.originEncounterId,
      appointmentId: clinicalFollowUp.appointmentId,
      repeatEveryMonths: clinicalFollowUp.repeatEveryMonths,
      kind: clinicalFollowUp.kind,
      startsAt: appointment.startsAt,
      appointmentStatus: appointment.status,
      // Quien lo indicó: el cierre dice qué control se cumple y de quién (QA del 9 nov, repaso 3).
      originProfessionalName: sql<string | null>`(select u."name" from ${encounter} e join ${user} u on u."id" = e."professional_user_id"
        where e."id" = ${clinicalFollowUp.originEncounterId} and e."organization_id" = ${clinicalFollowUp.organizationId}
          and e."professional_user_id" is distinct from ${row.professionalUserId})`,
    })
    .from(clinicalFollowUp)
    .leftJoin(
      appointment,
      and(eq(appointment.id, clinicalFollowUp.appointmentId), eq(appointment.organizationId, clinicalFollowUp.organizationId)),
    )
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, row.patientId),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
  // El reservado en la cita de esta atención lo cumple su cierre: no dice cuándo vuelve.
  const byAppointment = open.filter(
    (control) => row.appointmentId !== null && control.status === "programado" && control.appointmentId === row.appointmentId,
  )
  // Un control de tratamiento lejano (el radiográfico de la endodoncia, al año) no dice cuándo
  // vuelve: más allá del recordatorio de la clínica, «¿Cuándo vuelve?» se sigue preguntando
  // (revisión antes de entregar: si no, nadie podía indicar la limpieza de los 6 meses en un año).
  const recallDay = addMonthsToDay(today, recallMonths)
  const farTreatmentControl = (control: (typeof open)[number]) =>
    control.kind === "tratamiento" && control.status === "pendiente" && dayKeyIn(control.dueAt, timezone) > recallDay
  const first = open.find(
    (control) => !dueIds.has(control.id) && !byAppointment.includes(control) && !farTreatmentControl(control),
  )
  return {
    recallMonths,
    byAppointment: byAppointment.map(({ id, title, repeatEveryMonths, originProfessionalName }) => ({
      id,
      title,
      repeatEveryMonths,
      byName: originProfessionalName ?? null,
    })),
    // Desde el día de la visita (la de una cita pasada que se registra después), nunca antes de mañana.
    shortcuts: {
      week: notBefore(addDaysToDay(visitDay, 7), addDaysToDay(today, 1)),
      month: notBefore(addMonthsToDay(visitDay, 1), addDaysToDay(today, 1)),
      recall: notBefore(addMonthsToDay(visitDay, recallMonths), addDaysToDay(today, 1)),
    },
    due,
    open: open
      .filter((control) => !byAppointment.includes(control))
      .map((control) => ({
        id: control.id,
        title: control.title,
        dueAt: control.dueAt,
        status: control.status,
        scheduledAt:
          control.startsAt &&
          control.appointmentStatus &&
          ["programada", "confirmada"].includes(control.appointmentStatus)
            ? control.startsAt
            : null,
      })),
    next: first
      ? {
          id: first.id,
          title: first.title,
          dueAt: first.dueAt,
          status: first.status,
          scheduledAt:
            first.startsAt && first.appointmentStatus && ["programada", "confirmada"].includes(first.appointmentStatus)
              ? first.startsAt
              : null,
          own: first.originEncounterId === row.id,
        }
      : null,
    returnsTo: await returnsToOf(tx, orgId, row),
  }
}

/** Lo que falta hacer, sin cita, si hoy no se registró ningún procedimiento (`ClosingControls.returnsTo`). */
async function returnsToOf(tx: Db, orgId: string, row: EncounterRow): Promise<string[]> {
  const rows = await tx.execute<{ title: string }>(sql`
    select item.title from treatment_plan_item item
    where item.organization_id = ${orgId} and item.patient_id = ${row.patientId}
      and item.status in ('pendiente', 'programado')
      and (item.decision_status = 'aceptado' or (item.decision_status = 'pendiente' and item.source_encounter_id = ${row.id}))
      and not exists (select 1 from encounter_procedure today where today.organization_id = item.organization_id
        and today.encounter_id = ${row.id} and today.voided_at is null)
      and not exists (select 1 from appointment_plan_item link
        join appointment a on a.organization_id = link.organization_id and a.id = link.appointment_id
        where link.organization_id = item.organization_id and link.plan_item_id = item.id
          and a.status in ('programada', 'confirmada') and a.starts_at > now())
    order by item.sort_order, item.created_at, item.id
    limit 4`)
  return [...new Set(rows.map((item) => item.title))]
}

/** La hora a la que se anota el día de un control, como «Indicar control» en la pantalla. */
const CONTROL_MINUTES = 9 * 60

/**
 * El control de «¿Cuándo vuelve?»: con «En N meses», de mantenimiento; si no,
 * el del primer procedimiento de hoy («Control de resina simple»), y si no hubo
 * ninguno, «Control». El tipo y el título los pone el sistema.
 */
async function createNextControl(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: EncounterRow,
  day: string,
  controls: ClosingControls,
  timezone: string,
): Promise<{ id: string; title: string; dueAt: Date }> {
  const dueAt = zonedTimeToUtc(day, CONTROL_MINUTES, timezone).toISOString()
  if (day === controls.shortcuts.recall) {
    const created = await createFollowUp(tx, orgId, actorUserId, row.patientId, {
      kind: "mantenimiento",
      // «Control de mantenimiento» en odentIA, «Control anual» en latidIA.
      title: (await productHooks(tx, orgId)).recallControlTitle,
      dueAt,
      originEncounterId: row.id,
    })
    return { id: created.id, title: created.title, dueAt: created.dueAt }
  }
  const [procedure] = await tx
    .select({ id: encounterProcedure.id, description: encounterProcedure.description, planItemId: encounterProcedure.planItemId })
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, row.id),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id))
    .limit(1)
  const name = procedure?.description.trim()
  // «Resina simple» → «Control de resina simple»; una sigla («RX») queda como está.
  const said = name && /^\p{Lu}\p{Ll}/u.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name
  const created = await createFollowUp(tx, orgId, actorUserId, row.patientId, {
    kind: procedure?.planItemId ? "tratamiento" : "mantenimiento",
    title: said ? `Control de ${said}`.slice(0, 200) : "Control",
    dueAt,
    originEncounterId: row.id,
    planItemId: procedure?.planItemId ?? null,
    encounterProcedureId: procedure?.id ?? null,
  })
  return { id: created.id, title: created.title, dueAt: created.dueAt }
}

/**
 * Cumple los controles por cumplir con esta atención ya firmada (ADR 0152): la
 * misma marca que la cita del control (`closeAppointment`), con `by: "ventana"`
 * en la auditoría, y el que se repite deja indicado el siguiente.
 */
async function fulfillDueControls(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: EncounterRow,
  ids: string[],
  at: Date,
): Promise<Array<{ id: string; title: string }>> {
  if (ids.length === 0) return []
  const completed = await tx
    .update(clinicalFollowUp)
    .set({ status: "realizado", completedEncounterId: row.id, completedAt: at, updatedAt: at })
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, row.patientId),
        inArray(clinicalFollowUp.id, ids),
        eq(clinicalFollowUp.status, "pendiente"),
      ),
    )
    .returning()
  for (const followUp of completed) {
    await audit(tx, orgId, actorUserId, "follow_up.completed", "clinical_follow_up", followUp.id, {
      patientId: row.patientId,
      encounterId: row.id,
      by: "ventana",
    })
    // Si ya queda otro control abierto (el de «¿Cuándo vuelve?» u otro), no se repite: nunca dos.
    await repeatFollowUp(tx, orgId, actorUserId, followUp, { unlessOpen: true })
  }
  return completed.map((followUp) => ({ id: followUp.id, title: followUp.title }))
}

export async function getEncounterClosing(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  /** Lo que en pantalla ya dice «Falta otra sesión» (ADR 0161). */
  keepOpenPlanItemIds: readonly string[] = [],
): Promise<ClosingCheck> {
  const row = await requireEncounter(tx, orgId, patientId, encounterId)
  return checkEncounterClosing(tx, orgId, actorUserId, row, keepOpenPlanItemIds)
}

export interface FinalizeEncounterInput {
  /** Hora de fin declarada (ISO); por defecto, ahora. */
  endedAt?: string | null
  /**
   * «Seguir sin él»: por qué se cierra con un consentimiento sin firmar. Se
   * pide solo si falta alguno; queda en la atención como el resto.
   */
  consentSkipReason?: string | null
  /**
   * «¿Cuándo vuelve?» (ADR 0152): el día civil del próximo control, o que no
   * hace falta. Sin él, no se indicó: recepción no lo verá.
   */
  nextControl?: { dueAt: string } | { none: true } | null
  /**
   * Los controles por cumplir que esta visita cumple (`ClosingControls.due`).
   * Sin él (API sin pantalla), los de quien firma (`mine`) y el que se eligió
   * al empezar («Viene a su control», `chosen`): los que la pantalla trae marcados.
   */
  followUpIds?: string[] | null
  /**
   * «Sí, terminar»: los tratamientos trabajados hoy que quedan realizados al
   * firmar. Lo que llega a sus sesiones previstas (`closing.sessions.finishing`)
   * se termina también sin mencionarlo, salvo que venga en
   * `addSessionPlanItemIds` (ADR 0161). Aquí sirve para terminar antes uno al
   * que aún le faltan sesiones.
   */
  completePlanItemIds?: string[]
  /** «Falta otra sesión»: a cada uno se le prevé una sesión más (`updatePlanItemPlanning`) y sigue en curso. */
  addSessionPlanItemIds?: string[]
  /**
   * Los diagnósticos que el cierre proponía resolver (`closing.resolvable`) y la
   * pantalla mostró marcados: quedan resueltos con su tratamiento. Sin él, ninguno.
   */
  resolveDiagnosisIds?: string[]
  /**
   * Lo que quien firma cambió de los controles que dejan los tratamientos de hoy
   * (`closing.controls.finishing`, por su `key`): otro día o quitarlo, solo para esta persona.
   */
  finishControlChanges?: FinishingControlChange[]
}

/**
 * «Sí, terminar» y «Falta otra sesión» del cierre. Solo de lo trabajado en esta
 * atención (`closing.sessions`); un mismo tratamiento no puede ir en las dos.
 * Lo que llega a sus sesiones previstas se termina sin respuesta: «Sí, terminar»
 * es lo que viene elegido y solo «Falta otra sesión» lo deja abierto (ADR 0161;
 * la resina de una sesión hecha y cobrada quedaba «en curso» y fuera del
 * odontograma firmado). Completa aquí y devuelve la sesión que falta para
 * sumarla después de los cobros: lo que se cobra hoy se mide con lo que se
 * había previsto, no con la sesión que se acaba de agregar.
 */
async function applySessionAnswers(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: FinalizeEncounterInput,
  sessions: ClosingCheckBase["sessions"],
  at?: Date,
): Promise<{ addSessions: () => Promise<void>; keptOpen: SessionKeptOpen[] }> {
  const chosen = [...new Set(input.completePlanItemIds ?? [])]
  const addSession = [...new Set(input.addSessionPlanItemIds ?? [])]
  if (chosen.some((id) => addSession.includes(id)))
    throw validation("Un tratamiento se termina o le falta otra sesión, no las dos")
  const worked = new Set([...sessions.finishing, ...sessions.continuing].map((session) => session.planItemId))
  const field = (ids: string[], name: string) => {
    if (ids.some((id) => !worked.has(id)))
      throw invalidField(name, "Solo se responde por lo que se trabajó en esta atención")
  }
  field(chosen, "completePlanItemIds")
  field(addSession, "addSessionPlanItemIds")
  for (const itemId of chosen)
    await setPlanItemStatus(tx, orgId, actorUserId, patientId, itemId, { status: "realizado", encounterId, at })
  // Lo que llega a sus previstas se termina salvo «Falta otra sesión». Lo que viene
  // elegido no frena la firma: si algo impide completarlo (un presupuesto anulado
  // a medias), queda en curso como antes y el resultado lo dice. La traza distingue
  // lo terminado sin respuesta de «Sí, terminar».
  const keptOpen: SessionKeptOpen[] = []
  for (const session of sessions.finishing) {
    if (chosen.includes(session.planItemId) || addSession.includes(session.planItemId)) continue
    try {
      await tx.transaction(async (inner) => {
        await setPlanItemStatus(inner as Db, orgId, actorUserId, patientId, session.planItemId, { status: "realizado", encounterId, at })
        await audit(inner as Db, orgId, actorUserId, "plan.item_completed_on_sign", "treatment_plan_item", session.planItemId, {
          patientId,
          encounterId,
          sessions: { n: session.n, m: session.m },
        })
      })
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error
      keptOpen.push({ planItemId: session.planItemId, title: session.title, reason: error.message })
    }
  }
  const addSessions = async () => {
    for (const itemId of addSession) {
      const [current] = await tx
        .select({ plannedSessions: treatmentPlanItem.plannedSessions })
        .from(treatmentPlanItem)
        .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, itemId)))
      if (!current) throw notFound("Tratamiento")
      // Lo previsto pasa a lo hecho más una: «Falta otra sesión» cuando ya iba por la tercera de dos.
      const done = [...sessions.finishing, ...sessions.continuing].find((session) => session.planItemId === itemId)?.n ?? 0
      await updatePlanItemPlanning(tx, orgId, actorUserId, patientId, itemId, {
        plannedSessions: Math.max(current.plannedSessions, done) + 1,
      })
    }
  }
  return { addSessions, keptOpen }
}

export async function finalizeEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: FinalizeEncounterInput = {},
): Promise<FinalizeEncounterResult> {
  await requirePatient(tx, orgId, patientId)
  // El cierre participa del mismo bloqueo que los cargos manuales y de
  // presupuesto: consultar cobertura y generar cargos es una sola operación.
  await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención ya está finalizada")
  assertOpenDraft(locked, actorUserId)
  // Una consulta puede terminar sin prestaciones: documentarla no obliga a
  // inventar procedimientos, tratamientos ni cargos; sí exige el mínimo clínico.
  const closing = await checkEncounterClosing(tx, orgId, actorUserId, locked)
  if (!closing.ready) {
    throw new ServiceError(
      "CLOSING_INCOMPLETE",
      409,
      `Para cerrar la atención registra ${closing.missing.map((m) => CLOSING_MESSAGES[m]).join(", ")}`,
    )
  }
  // Un consentimiento sin firmar avisa sin bloquear: se sigue diciendo por qué.
  let consentSkipReason: string | null = null
  if (closing.consents.length > 0) {
    const reason = input.consentSkipReason?.trim() ?? ""
    if (!reason) {
      const message = `Falta el consentimiento de ${closing.consents.map((need) => `«${need.title}»`).join(", ")}: fírmalo ahora o sigue sin él diciendo por qué`
      throw new ServiceError("CONSENT_UNSIGNED", 409, message, { consentSkipReason: message })
    }
    if (reason.length > 2000) throw invalidField("consentSkipReason", "El motivo admite hasta 2000 caracteres")
    consentSkipReason = reason
  }
  const signature = await requireProfessionalSignature(tx, orgId, actorUserId)
  const now = new Date()
  // «¿Cuándo vuelve?» y los controles que cumple esta visita (ADR 0152).
  const { timezone } = await findOrgLocale(tx, orgId)
  const wanted = input.followUpIds ? new Set(input.followUpIds) : null
  const fulfilling = closing.controls.due.filter((control) =>
    wanted ? wanted.has(control.id) : control.mine || control.chosen,
  )
  const nextDay = input.nextControl && "dueAt" in input.nextControl ? input.nextControl.dueAt : null
  if (nextDay !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(nextDay) || nextDay <= dayKeyIn(now, timezone)))
    throw invalidField("nextControl.dueAt", "Elige un día desde mañana.")
  let endedAt = now
  // La atención de otro día (la de una cita pasada, o un borrador de ayer) termina ese día:
  // sin hora indicada, a la hora de fin de su cita o, sin cita, media hora después de empezar.
  if (!input.endedAt && dayKeyIn(locked.startedAt, timezone) < dayKeyIn(now, timezone)) {
    const [visit] = locked.appointmentId
      ? await tx
          .select({ endsAt: appointment.endsAt })
          .from(appointment)
          .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, locked.appointmentId)))
          .limit(1)
      : []
    const planned = visit && visit.endsAt > locked.startedAt ? visit.endsAt : new Date(locked.startedAt.getTime() + 30 * 60_000)
    // Nunca después de ahora: una de anoche que se firma de madrugada termina, a lo sumo, ahora.
    endedAt = planned < now ? planned : now
  }
  if (input.endedAt) {
    endedAt = new Date(input.endedAt)
    if (Number.isNaN(endedAt.getTime())) throw invalidField("endedAt", "Elige la hora de fin de la lista")
    if (endedAt < locked.startedAt)
      throw invalidField("endedAt", "La hora de fin no puede ser anterior al inicio de la atención")
    if (endedAt.getTime() > now.getTime() + 5 * 60_000)
      throw invalidField("endedAt", "La hora de fin no puede estar en el futuro")
  }
  // «¿Terminaste?» (lo respondido, o «Sí, terminar» si nadie lo cambió), en la misma
  // transacción y con la atención aún en borrador: completar lo exige y deja dibujado
  // lo tratado antes del cierre del producto (odentIA: el odontograma que se firma ya lo trae).
  // La visita es cuando fue: lo que se cierra con ella (tratamientos, controles, diagnósticos)
  // queda con su hora de fin; la firma (`finalizedAt`) queda con la de ahora.
  const visitAt = endedAt
  const { addSessions, keptOpen } = await applySessionAnswers(tx, orgId, actorUserId, patientId, encounterId, input, closing.sessions, visitAt)
  // Los controles que dejó lo terminado, como quedaron en el cierre (otro día, o quitados).
  await applyFinishingControlChanges(tx, { orgId, actorUserId, patientId, encounterId }, input.finishControlChanges ?? [])
  // Lo que hoy quedó realizado resuelve su diagnóstico de esa pieza, si quien firma lo dejó marcado.
  await resolveDiagnosesOnSign(tx, orgId, actorUserId, patientId, encounterId, input.resolveDiagnosisIds ?? [], visitAt)
  const procedures = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.encounterId, encounterId),
        eq(encounterProcedure.organizationId, orgId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
  // El control nuevo se indica con la atención aún abierta, como «Indicar control». Si la persona ya
  // tiene uno, si el que se cumple (por la ventana o por su cita) se repite, o si quien firma deja sin
  // marcar uno suyo, no se crea otro: dos controles no son dos visitas. Uno de un colega sin marcar no
  // lo impide: quien firma decide cuándo vuelve.
  const repeats =
    fulfilling.some((control) => control.repeatEveryMonths) ||
    closing.controls.byAppointment.some((control) => control.repeatEveryMonths)
  const stays = closing.controls.due.some((control) => control.mine && !fulfilling.includes(control))
  // Sin nada hecho hoy y con algo por hacer sin cita, la vuelta es para eso: no un control aparte
  // (M6 y B7). «En N meses» sigue siendo el mantenimiento.
  // Solo una vuelta corta (hasta «En 1 mes»): más lejos es un control, como siempre (revisión de la entrega 12).
  const returnsToPlan =
    nextDay !== null && nextDay <= closing.controls.shortcuts.month && closing.controls.returnsTo.length > 0
  const nextControl =
    nextDay !== null && !closing.controls.next && !repeats && !stays && !returnsToPlan
      ? await createNextControl(tx, orgId, actorUserId, locked, nextDay, closing.controls, timezone)
      : null
  const [row] = await tx
    .update(encounter)
    .set({
      status: "finalizada",
      finalizedAt: now,
      finalizedBy: actorUserId,
      endedAt,
      signerName: signature.name,
      signerTitle: signature.title,
      signerRegistration: signature.registration,
      consentSkipReason,
      updatedAt: now,
    })
    .where(eq(encounter.id, encounterId))
    .returning()
  if (!row) throw notFound("Atención")
  // Lo del producto al firmar (odentIA: deja tratado lo realizado y, en Perú,
  // firma el odontograma con el mismo perfil; NTS 188, 5.3 y 5.10).
  const product = await (await productHooks(tx, orgId)).encounterFinalized(tx, {
    orgId,
    actorUserId,
    patientId,
    encounterId,
    at: now,
    signer: signature,
  })
  if (row.appointmentId) await closeAppointment(tx, orgId, actorUserId, patientId, row, visitAt)
  const fulfilled = await fulfillDueControls(tx, orgId, actorUserId, row, fulfilling.map((control) => control.id), visitAt)
  // Con lo dictado confirmado, el Asistente clínico ordenó esta consulta (ADR 0031).
  await countConsultationAction(tx, orgId, { patientId, encounterId, at: now })
  // Los cargos caen solos al finalizar, con el precio final acordado:
  // - Modo `treatment`: un cargo por tratamiento (anti-doble-cobro por cargo
  //   activo del mismo tratamiento; el importe respeta el total acordado).
  // - Modo `session`: un cargo por visita atendida al precio de sesión
  //   acordado, con tope de visitas previstas y sin duplicar el acto
  //   (anti-doble-cargo por procedimiento). La deuda nace por visita: su
  //   línea no se carga antes (`createCharge` lo rechaza, ADR 0159), y lo
  //   pagado antes es un adelanto a favor que cancela este cargo al cobrarlo.
  const charges: FinalizeEncounterResult["charges"] = []
  const skippedCharges: SkippedCharge[] = []
  const billingLines: FinalizeBillingLine[] = []
  const skip = (
    proc: { id: string; description: string; currency: string | null },
    reason: SkippedCharge["reason"],
  ): void => {
    skippedCharges.push({ procedureId: proc.id, reason })
    billingLines.push({
      procedureId: proc.id,
      description: proc.description,
      amountCents: null,
      currency: proc.currency,
      status: "skipped",
      reason,
    })
  }
  // Lo devuelto entero de cada tratamiento de la atención: cuenta como cobrado (ADR 0068).
  const returnedByPlanItem = new Map<string, WholeReturnedCharge[]>()
  for (const charge of await wholeReturnedCharges(
    tx,
    orgId,
    patientId,
    [...new Set(procedures.flatMap((proc) => (proc.planItemId ? [proc.planItemId] : [])))],
  )) {
    returnedByPlanItem.set(charge.planItemId, [...(returnedByPlanItem.get(charge.planItemId) ?? []), charge])
  }
  for (const proc of procedures) {
    if (!proc.serviceId) {
      skip(proc, "free_act")
      continue
    }
    const line = proc.planItemId
      ? await acceptedBudgetLine(tx, orgId, patientId, proc.planItemId)
      : null
    // Lo acordado en el presupuesto manda; sin presupuesto aceptado decide el
    // servicio: un control por sesión se cobra en cada visita igualmente.
    const serviceMode = line ? null : (await readBillingModes(tx, orgId, [proc.serviceId]))[proc.serviceId]
    const sessionMode = (line?.billingMode ?? serviceMode) === "session"
    // La promoción acordada viaja congelada: no se revalida su vigencia.
    const frozenPromotion =
      line?.promotionId && line.promotionName
        ? { id: line.promotionId, name: line.promotionName }
        : undefined
    if (sessionMode && proc.planItemId) {
      const [duplicate] = await tx
        .select({ id: patientCharge.id })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            eq(patientCharge.encounterProcedureId, proc.id),
            isNull(patientCharge.voidedAt),
          ),
        )
        .limit(1)
      if (duplicate) {
        skip(proc, "covered")
        continue
      }
      const visits = await tx
        .select({ id: patientCharge.id })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            eq(patientCharge.planItemId, proc.planItemId),
            isNotNull(patientCharge.encounterProcedureId),
            isNull(patientCharge.voidedAt),
          ),
        )
      const [planItem] = proc.planItemId
        ? await tx
            .select({ plannedSessions: treatmentPlanItem.plannedSessions })
            .from(treatmentPlanItem)
            .where(
              and(
                eq(treatmentPlanItem.id, proc.planItemId),
                eq(treatmentPlanItem.organizationId, orgId),
              ),
            )
            .limit(1)
        : []
      // El tope son las visitas previstas. Si nadie las fijó no hay tope:
      // se cobra cada visita atendida, no solo la primera. Una visita cuyo
      // cobro se devolvió entero también cuenta: no deja otra por cobrar.
      const cap = line?.sessionsPlanned ?? planItem?.plannedSessions ?? null
      const returnedVisits = (returnedByPlanItem.get(proc.planItemId) ?? []).filter(
        (charge) => charge.encounterProcedureId !== null,
      )
      if (cap !== null && visits.length + returnedVisits.length >= cap) {
        skip(proc, visits.length >= cap ? "sessions_complete" : "returned")
        continue
      }
      const amount = line?.priceCents ?? proc.priceCents
      if (amount === null || amount <= 0) {
        skip(proc, "zero_price")
        continue
      }
      const charge = await createCharge(tx, orgId, actorUserId, patientId, {
        encounterProcedureId: proc.id,
        amountCents: amount,
        frozenPromotion,
      })
      charges.push(charge)
      billingLines.push({
        procedureId: proc.id,
        description: charge.description,
        amountCents: charge.amountCents,
        currency: charge.currency,
        status: "charged",
        reason: null,
      })
      continue
    }
    if (proc.priceCents === null || proc.priceCents <= 0) {
      skip(proc, "zero_price")
      continue
    }
    if (proc.planItemId) {
      // Lo cobrado incluye lo devuelto (ADR 0068): una devolución no deja otra vez por cobrar el tratamiento.
      const active = await tx
        .select({
          amountCents: patientCharge.amountCents,
          returnedCents: patientCharge.returnedCents,
          discountCents: patientCharge.discountCents,
          requestKey: patientCharge.requestKey,
        })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            eq(patientCharge.planItemId, proc.planItemId),
            isNull(patientCharge.voidedAt),
          ),
        )
      const agreed = line?.priceCents ?? proc.priceCents
      // Lo descontado en Cobrar también cuenta: si no, la sesión siguiente volvería a cobrarlo.
      const charged = active.reduce((sum, c) => sum + c.amountCents + c.returnedCents + c.discountCents, 0)
      // Lo devuelto entero también se cobró: la recepción lo vuelve a cobrar a mano si corresponde.
      // Como `active`, sin mirar la moneda: un tratamiento se acuerda en una sola.
      const returnedWhole = returnedByPlanItem.get(proc.planItemId) ?? []
      const remaining = agreed - charged - returnedWhole.reduce((sum, c) => sum + c.chargedCents, 0)
      if (remaining <= 0) {
        skip(proc, charged < agreed ? "returned" : "covered")
        continue
      }
      // Por tratamiento se cobra lo acordado completo en la primera
      // atención, también cuando lo acordado supera la tarifa del acto.
      const amount = remaining
      // Con varias sesiones previstas, la comisión de cada cobro se reparte por sesión (ADR 0151).
      const [planned] = await tx
        .select({ sessions: treatmentPlanItem.plannedSessions })
        .from(treatmentPlanItem)
        .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, proc.planItemId)))
      const charge = await createCharge(tx, orgId, actorUserId, patientId, {
        encounterProcedureId: proc.id,
        amountCents: amount,
        frozenPromotion,
        commissionSessions: planned && planned.sessions > 1 ? planned.sessions : null,
      })
      charges.push(charge)
      const advance = active
        .filter((c) => c.requestKey?.startsWith(ADVANCE_KEY))
        .reduce((sum, c) => sum + c.amountCents, 0)
      billingLines.push({
        procedureId: proc.id,
        description: charge.description,
        amountCents: charge.amountCents,
        currency: charge.currency,
        status: "charged",
        reason: null,
        ...(advance > 0 ? { agreedCents: agreed, advanceCents: advance } : {}),
      })
      continue
    }
    const [duplicate] = await tx
      .select({ id: patientCharge.id })
      .from(patientCharge)
      .where(
        and(
          eq(patientCharge.organizationId, orgId),
          eq(patientCharge.patientId, patientId),
          eq(patientCharge.encounterProcedureId, proc.id),
          isNull(patientCharge.voidedAt),
        ),
      )
      .limit(1)
    if (duplicate) {
      skip(proc, "covered")
      continue
    }
    const charge = await createCharge(tx, orgId, actorUserId, patientId, {
      encounterProcedureId: proc.id,
    })
    charges.push(charge)
    billingLines.push({
      procedureId: proc.id,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
      status: "charged",
      reason: null,
    })
  }
  // «Falta otra sesión», ya con los cobros de hoy medidos contra lo previsto.
  await addSessions()
  // Lo que sigue en curso, ya con lo respondido: con la sesión que se sumó y sin lo que se terminó.
  const continuingNext = await nextSessionsOf(
    tx,
    orgId,
    [...closing.sessions.finishing, ...closing.sessions.continuing].map((session) => session.planItemId),
    row.appointmentId ?? null,
  )
  // Si nada sigue en curso, vuelve para lo aceptado sin empezar (la corona tras terminar la
  // endodoncia): «Reservar» lo deja con su cita ahí mismo. Mientras algo sigue, no: la corona
  // no va en la cita de la sesión 2 (QA del 9 nov).
  // Lo que va después de lo que sigue en curso y ya tiene su cita: el cierre lo avisa.
  const bookedAfter = await bookedAfterOf(
    tx,
    orgId,
    continuingNext.map((session) => session.planItemId),
  )
  const nextSessions = continuingNext.length
    ? continuingNext
    : await nextSessionsOf(tx, orgId, closing.sessions.accepted.map((session) => session.planItemId), row.appointmentId ?? null)
  const chargedCents = billingLines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0)
  // Entre monedas no se suma: cada una con su total.
  const chargedTotals = sumByCurrency(
    billingLines.flatMap((line) =>
      line.currency == null || line.amountCents == null
        ? []
        : [{ currency: line.currency, cents: line.amountCents }],
    ),
  ).map(({ currency, cents }) => ({ currency, totalCents: cents }))
  // Los materiales de sus servicios salen solos de la sede de la atención
  // (ADR 0067): lo que no alcanza queda como faltante y nunca bloquea el cierre.
  const materials = await discountEncounterMaterials(tx, orgId, actorUserId, row)
  await audit(tx, orgId, actorUserId, "encounter.finalized", "encounter", encounterId, {
    patientId,
    charges: charges.length,
    skippedCharges: skippedCharges.length,
    // Cuántos consentimientos quedaron sin firmar; el motivo vive en la atención.
    consentsUnsigned: closing.consents.length,
    materials: materials?.items.length ?? 0,
    // Lo que faltaba saber de su salud al firmar, y si se usó anestesia: la constancia del aviso.
    healthGaps: closing.health.gaps,
    anesthetics: closing.health.anesthetics.length,
    // Cuántos formularios quedaron a medias al firmar: la constancia de ese aviso.
    openForms: closing.openForms.length,
    // La constancia de «¿Cuándo vuelve?»: lo que se eligió, o que no se indicó.
    nextControl: nextControl
      ? "fecha"
      : returnsToPlan
        ? "vuelve_a_lo_por_hacer"
        : input.nextControl && "none" in input.nextControl
        ? "no_hace_falta"
        : closing.controls.next || repeats || stays
          ? "ya_tenia"
          : // Mientras un tratamiento sigue en curso la pantalla no pregunta por un control (`continuingAfterSign`):
            // lo que no llega a sus previstas, sin lo que se eligió terminar, y lo de «Falta otra sesión».
            closing.sessions.continuing.some((session) => !(input.completePlanItemIds ?? []).includes(session.planItemId)) ||
              (input.addSessionPlanItemIds ?? []).length > 0
            ? "sesion_en_curso"
            : // Lo mismo con lo aceptado sin empezar a lo que vuelve (la corona tras la endodoncia).
              closing.sessions.accepted.length > 0
              ? "aceptado_por_empezar"
              : "sin_indicar",
    controlsFulfilled: fulfilled.length,
    // El día que se dijo y para qué: no queda en un control (M6).
    ...(returnsToPlan ? { returnsTo: { day: nextDay, titles: closing.controls.returnsTo } } : {}),
  })
  // Al firmar queda armado el presupuesto con lo indicado aquí: crece el
  // borrador de la persona o nace uno. No se envía solo.
  const budget = await assembleEncounterBudget(tx, orgId, actorUserId, patientId, encounterId)
  await notifyClose(tx, orgId, "encounter.finalized")
  await notifyClose(tx, orgId, "patient.account.updated")
  return {
    encounter: row,
    charges,
    skippedCharges,
    budget,
    materials,
    controls: {
      next:
        nextControl &&
        continuingNext.length === 0 &&
        nextSessions.some((session) => session.toBook !== null) &&
        pairsWithAccepted({ dueAt: nextControl.dueAt, createdAt: now })
          ? {
              ...nextControl,
              joinsNext: {
                from: dayKeyIn(
                  controlWindowStart({ dueAt: nextControl.dueAt, createdAt: now }),
                  timezone,
                ),
              },
            }
          : nextControl,
      fulfilled,
      // «En 1 semana» para lo que falta hacer: el día que se dijo y para qué, sin control (M6).
      returnsTo: returnsToPlan && nextDay ? { day: nextDay, titles: closing.controls.returnsTo } : null,
    },
    keptOpen,
    bookedAfter,
    freedAppointments: await freedAppointmentsOf(
      tx,
      orgId,
      patientId,
      [...closing.sessions.finishing, ...closing.sessions.continuing].map(
        (session) => session.planItemId,
      ),
    ),
    waitingAfter:
      continuingNext.length > 0
        ? closing.sessions.accepted
            .filter((session) => !session.booked && !bookedAfter.some((row) => row.planItemId === session.planItemId))
            .map((session) => ({
              planItemId: session.planItemId,
              title: session.title,
              ...(session.place ? { place: session.place } : {}),
              beforeTitle: continuingNext[0]!.title,
            }))
        : [],
    nextSessions,
    billing: {
      chargedCents: chargedTotals.length > 1 ? null : chargedCents,
      currency: charges[0]?.currency ?? procedures[0]?.currency ?? null,
      totals: chargedTotals,
      lines: billingLines,
    },
    ...product,
  }
}

export async function addEncounterAddendum(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { text: string },
): Promise<EncounterNoteRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status !== "finalizada") {
    throw conflict("NOT_FINALIZED", "Solo se puede agregar una adenda a una atención finalizada")
  }
  const text = input.text?.trim() ?? ""
  if (text.length < 1 || text.length > 4000) throw invalidField("text", "Escribe la adenda: hasta 4000 caracteres")
  const [row] = await tx
    .insert(clinicalNote)
    .values({
      organizationId: orgId,
      patientId,
      authorUserId: actorUserId,
      note: text,
      encounterId,
      kind: "adenda",
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la adenda")
  await audit(tx, orgId, actorUserId, "encounter.addendum_added", "clinical_note", row.id, {
    patientId,
    encounterId,
  })
  return withSite(await siteOf(tx, orgId), row)
}

function cleanReason(reason: string | null | undefined): string {
  const text = reason?.trim() ?? ""
  if (text.length < 1 || text.length > 2000)
    throw invalidField("reason", "Escribe el motivo: hasta 2000 caracteres")
  return text
}

/**
 * La cita atendida se cierra con la atención: los controles reservados en ella
 * quedan realizados con esta atención y la cita pasa a «atendida».
 */
async function closeAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  row: EncounterRow,
  at: Date,
): Promise<void> {
  if (!row.appointmentId) return
  const completed = await tx
    .update(clinicalFollowUp)
    .set({
      status: "realizado",
      completedEncounterId: row.id,
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        eq(clinicalFollowUp.appointmentId, row.appointmentId),
        eq(clinicalFollowUp.status, "programado"),
      ),
    )
    .returning()
  for (const followUp of completed) {
    await audit(tx, orgId, actorUserId, "follow_up.completed", "clinical_follow_up", followUp.id, {
      patientId,
      encounterId: row.id,
    })
    // El que se repite deja indicado el siguiente (issue 229, decisión 16), si no
    // queda ya otro control abierto: la firma nunca deja dos (ADR 0152).
    await repeatFollowUp(tx, orgId, actorUserId, followUp, { unlessOpen: true })
  }
  await setAppointmentStatus(tx, orgId, actorUserId, row.appointmentId, "atendida")
}

/**
 * Anula un procedimiento del borrador sin borrarlo: no genera cargo ni cuenta
 * como sesión. La indicación vuelve a su carril real: un tratamiento directo
 * se cancela; uno planificado queda en curso si le quedan sesiones o vuelve a
 * programado si no.
 */
async function voidProcedureRow(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  proc: typeof encounterProcedure.$inferSelect,
  reason: string,
  at: Date,
): Promise<EncounterProcedureRow> {
  const [voided] = await tx
    .update(encounterProcedure)
    .set({ voidedAt: at, voidedBy: actorUserId, voidReason: reason })
    .where(
      and(
        eq(encounterProcedure.id, proc.id),
        eq(encounterProcedure.organizationId, orgId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .returning()
  if (!voided) throw conflict("ALREADY_VOIDED", "El procedimiento ya está anulado")
  if (proc.planItemId) {
    const [item] = await tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, proc.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
      .for("update")
      .limit(1)
    if (item) {
      const direct =
        item.sourceEncounterId === encounterId &&
        (item.decisionNote ?? "").startsWith("Tratamiento directo")
      if (direct) {
        await tx
          .update(treatmentPlanItem)
          .set({
            status: "cancelado",
            statusReason: `Procedimiento anulado: ${reason}`,
            completedAt: null,
            updatedAt: at,
          })
          .where(eq(treatmentPlanItem.id, item.id))
      } else if (item.status === "en_curso" || item.status === "realizado") {
        const [remaining] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(encounterProcedure)
          .where(
            and(
              eq(encounterProcedure.organizationId, orgId),
              eq(encounterProcedure.planItemId, item.id),
              isNull(encounterProcedure.voidedAt),
            ),
          )
        const sessions = remaining?.n ?? 0
        await tx
          .update(treatmentPlanItem)
          .set({
            status: sessions > 0 ? "en_curso" : "programado",
            completedAt: null,
            ...(sessions > 0 ? {} : { startedAt: null }),
            updatedAt: at,
          })
          .where(eq(treatmentPlanItem.id, item.id))
      }
      // Ya no está realizado: lo que dejó dibujado en esta atención se anula.
      if (direct || item.status === "realizado") {
        await (await productHooks(tx, orgId)).treatmentUndone(tx, { orgId, actorUserId, patientId, encounterId, planItemId: item.id, reason, at })
        await undoFinishControls(tx, { orgId, actorUserId, patientId, planItemId: item.id, reason, at })
      }
    }
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "encounter.procedure_voided",
    "encounter_procedure",
    proc.id,
    {
      patientId,
      encounterId,
      planItemId: proc.planItemId,
      reason,
    },
  )
  return withSite(await siteOf(tx, orgId), voided)
}

export async function voidEncounterProcedure(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  procedureId: string,
  input: { reason: string },
): Promise<EncounterProcedureRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  const reason = cleanReason(input.reason)
  const [proc] = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.id, procedureId),
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, encounterId),
      ),
    )
    .limit(1)
  if (!proc) throw notFound("Procedimiento")
  if (proc.voidedAt) throw conflict("ALREADY_VOIDED", "El procedimiento ya está anulado")
  return voidProcedureRow(tx, orgId, actorUserId, patientId, encounterId, proc, reason, new Date())
}

/**
 * Anula el borrador completo (ADR 0002): queda en la historia como «anulada»
 * con quién, cuándo y por qué; no genera cargos ni controles. Anula con el
 * mismo motivo sus procedimientos, diagnósticos, hallazgos, recetas y
 * controles; la cita conserva su estado y puede volver a atenderse.
 */
/**
 * Los papeles de una atención anulada que aún valen (ADR 0002: se anula «lo
 * ligado»): el descanso médico emitido, las órdenes pedidas o en proceso (y la
 * tarea de una derivación), los consentimientos sin firmar y los formularios a
 * medias, que se descartan. Un consentimiento
 * firmado, o firmado por la persona en su enlace, no se toca: es un acto suyo
 * y anular la atención no lo retira; una orden con resultado tampoco, porque
 * el resultado ya existe. Así el código del papel (`/comprobar`) dice
 * «Anulado» en vez de «Vigente».
 */
async function voidEncounterPapers(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  reason: string,
  at: Date,
): Promise<void> {
  const leaves = await tx
    .update(medicalLeave)
    .set({ status: "anulado", cancelledAt: at, cancelledBy: actorUserId, cancelReason: reason, updatedAt: at })
    .where(
      and(
        eq(medicalLeave.organizationId, orgId),
        eq(medicalLeave.patientId, patientId),
        eq(medicalLeave.encounterId, encounterId),
        eq(medicalLeave.status, "emitido"),
      ),
    )
    .returning({ id: medicalLeave.id })
  for (const leave of leaves)
    await audit(tx, orgId, actorUserId, "medical_leave.cancelled", "medical_leave", leave.id, { encounterId, reason })
  const orders = await tx
    .update(clinicalOrder)
    .set({ status: "cancelado", cancelledAt: at, cancelledBy: actorUserId, cancelReason: reason, updatedAt: at })
    .where(
      and(
        eq(clinicalOrder.organizationId, orgId),
        eq(clinicalOrder.patientId, patientId),
        eq(clinicalOrder.encounterId, encounterId),
        inArray(clinicalOrder.status, ["solicitado", "en_proceso"]),
      ),
    )
    .returning({ id: clinicalOrder.id })
  for (const order of orders) {
    await audit(tx, orgId, actorUserId, "order.cancel", "clinical_order", order.id, { encounterId, reason })
    await cancelDerivationTask(tx, orgId, actorUserId, order.id)
  }
  const consents = await tx
    .update(consentDocument)
    .set({ status: "anulado", cancelledAt: at, cancelledBy: actorUserId, cancelReason: reason, updatedAt: at })
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.patientId, patientId),
        eq(consentDocument.encounterId, encounterId),
        eq(consentDocument.status, "pendiente"),
        // Lo que la persona ya firmó por su enlace espera al profesional, no se anula: es un acto suyo.
        isNull(consentDocument.personSignedAt),
        // El de un tratamiento que sigue vigente no se anula con la atención: va con el tratamiento y
        // se firma en la atención en que se haga (consentimientos, 10 nov).
        sql`(${consentDocument.planItemId} is null or not exists (select 1 from treatment_plan_item vigente
          where vigente.organization_id = ${consentDocument.organizationId} and vigente.id = ${consentDocument.planItemId}
            and vigente.status not in ('cancelado', 'reemplazado')))`,
      ),
    )
    .returning({ id: consentDocument.id })
  for (const consent of consents) {
    await tx.insert(consentEvent).values({
      organizationId: orgId,
      documentId: consent.id,
      fromStatus: "pendiente",
      toStatus: "anulado",
      actorUserId,
      reason,
    })
    await audit(tx, orgId, actorUserId, "consent.cancel", "consent_document", consent.id, { encounterId, reason })
  }
  // Sus formularios a medias: descartados con el mismo motivo (lo anotado para otra persona no
  // queda como un borrador que alguien pueda finalizar). Los finalizados no cambian.
  await discardVoidedEncounterForms(tx, orgId, actorUserId, encounterId, reason, at)
}

/**
 * Lo que se dio por realizado en esta atención sin una sesión suya (la cita
 * trajo el tratamiento y se completó aquí) deja de estarlo al anularla: vuelve
 * a «en curso» si le quedan sesiones válidas, o a «programado». Lo que tenía
 * su sesión aquí ya lo devolvió anular el procedimiento.
 */
async function undoCompletionsOf(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  reason: string,
  at: Date,
): Promise<void> {
  const completed = await tx
    .select({ id: treatmentPlanItem.id })
    .from(treatmentPlanItem)
    .innerJoin(
      encounterPlanItem,
      and(
        eq(encounterPlanItem.organizationId, treatmentPlanItem.organizationId),
        eq(encounterPlanItem.planItemId, treatmentPlanItem.id),
      ),
    )
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(encounterPlanItem.encounterId, encounterId),
        eq(treatmentPlanItem.status, "realizado"),
      ),
    )
  if (completed.length === 0) return
  const hooks = await productHooks(tx, orgId)
  for (const item of completed) {
    const [remaining] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.organizationId, orgId),
          eq(encounterProcedure.planItemId, item.id),
          isNull(encounterProcedure.voidedAt),
        ),
      )
    const sessions = remaining?.n ?? 0
    await tx
      .update(treatmentPlanItem)
      .set({
        status: sessions > 0 ? "en_curso" : "programado",
        completedAt: null,
        ...(sessions > 0 ? {} : { startedAt: null }),
        updatedAt: at,
      })
      .where(and(eq(treatmentPlanItem.id, item.id), eq(treatmentPlanItem.organizationId, orgId)))
    await audit(tx, orgId, actorUserId, "plan.item_status_changed", "treatment_plan_item", item.id, {
      patientId,
      from: "realizado",
      to: sessions > 0 ? "en_curso" : "programado",
      reason,
      encounterId,
    })
    await hooks.treatmentUndone(tx, { orgId, actorUserId, patientId, encounterId, planItemId: item.id, reason, at })
    await undoFinishControls(tx, { orgId, actorUserId, patientId, planItemId: item.id, reason, at })
  }
}

export interface VoidEncounterInput {
  reason: string
  /**
   * Lo entregado que se anula con la atención, como lo mostró el diálogo
   * (`getEncounterVoidPreview().confirm`): si no coincide con lo que hay al
   * anular, no se anula nada y se pide revisar.
   */
  budgets?: ReadonlyArray<{ id: string; status: string }>
}

/**
 * Qué se lleva anular esta atención: lo que el diálogo muestra antes de
 * confirmar. Solo para quien la lleva (es quien puede anularla).
 */
export async function getEncounterVoidPreview(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  /** `seesCharges`: quien ve la caja (`finance.read`) lee qué tratamiento se cobró. */
  opts: { memberRole?: string; seesCharges?: boolean } = {},
): Promise<EncounterVoidPreview & { revisions: Array<{ restored: string; replacement: string }> }> {
  await requirePatient(tx, orgId, patientId)
  const row = await requireEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(row, actorUserId)
  const preview = await encounterVoidBudgets(tx, orgId, patientId, encounterId, { actorUserId, ...opts })
  const revisions = await revisionsOf(tx, orgId, patientId, encounterId)
  return {
    ...preview,
    revisions: revisions.map((revision) => ({
      restored: revision.oldTooth ? `${revision.oldTitle} · ${revision.oldTooth}` : revision.oldTitle,
      replacement: revision.newTitle,
    })),
  }
}

export async function voidEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: VoidEncounterInput,
  opts: { memberRole?: string; seesCharges?: boolean } = {},
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "anulada") throw conflict("ALREADY_VOIDED", "La atención ya está anulada")
  assertOpenDraft(locked, actorUserId)
  const reason = cleanReason(input.reason)
  const cascade = `Atención anulada: ${reason}`.slice(0, 2000)
  // Lo indicado aquí que ya está en un presupuesto no desaparece en silencio:
  // lo no entregado se anula (o se le quita lo de aquí) y lo entregado, solo
  // si quien anula lo confirmó; lo que no se deshace frena.
  const budgets = await checkEncounterVoidBudgets(tx, orgId, patientId, encounterId, {
    actorUserId,
    memberRole: opts.memberRole,
    seesCharges: opts.seesCharges,
    confirmed: input.budgets,
  })
  const at = new Date()
  const procedures = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, encounterId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id))
  for (const proc of procedures) {
    await voidProcedureRow(tx, orgId, actorUserId, patientId, encounterId, proc, cascade, at)
  }
  // Un cambio de tratamiento hecho en ella se deshace: el anterior vuelve a como estaba.
  await undoRevisionsOf(tx, orgId, actorUserId, patientId, encounterId, cascade, at)
  await tx
    .update(treatmentPlanItem)
    .set({ status: "cancelado", statusReason: cascade, updatedAt: at })
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        inArray(treatmentPlanItem.status, ["pendiente", "programado", "suspendido"]),
      ),
    )
  await tx
    .update(encounterDiagnosis)
    .set({ voidedAt: at, voidedBy: actorUserId, voidReason: cascade, updatedAt: at })
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, encounterId),
        isNull(encounterDiagnosis.voidedAt),
      ),
    )
  // Lo que el producto registró en la atención (odentIA: sus hallazgos) también se anula.
  await (await productHooks(tx, orgId)).encounterVoided(tx, { orgId, actorUserId, patientId, encounterId, at, reason: cascade })
  await tx
    .update(prescription)
    .set({
      status: "anulada",
      cancelledAt: at,
      cancelledBy: actorUserId,
      cancelReason: cascade,
      updatedAt: at,
    })
    .where(
      and(
        eq(prescription.organizationId, orgId),
        eq(prescription.patientId, patientId),
        eq(prescription.encounterId, encounterId),
        eq(prescription.status, "emitida"),
      ),
    )
  await tx
    .update(clinicalFollowUp)
    .set({ status: "cancelado", cancelledReason: cascade, cancelledAt: at, updatedAt: at })
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        eq(clinicalFollowUp.originEncounterId, encounterId),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
  await voidEncounterPapers(tx, orgId, actorUserId, patientId, encounterId, cascade, at)
  await undoCompletionsOf(tx, orgId, actorUserId, patientId, encounterId, cascade, at)
  await settleEncounterVoidBudgets(tx, orgId, actorUserId, patientId, encounterId, budgets)
  const [row] = await tx
    .update(encounter)
    .set({
      status: "anulada",
      voidedAt: at,
      voidedBy: actorUserId,
      voidReason: reason,
      updatedAt: at,
    })
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.voided", "encounter", encounterId, {
    patientId,
    reason,
    procedures: procedures.length,
    ...(budgets.length > 0 ? { budgets: budgets.map((budget) => ({ id: budget.id, effect: budget.effect })) } : {}),
  })
  // La Agenda deja de decir «En atención»: la cita vuelve a poder atenderse y
  // su llegada se conserva (ADR 0032).
  if (row.appointmentId) await notifyAppointmentChanged(tx, orgId)
  return row
}

/**
 * Relevo: otro profesional continúa el borrador. Queda registrado quién lo
 * llevaba; desde ahí, quien toma el relevo es quien firma.
 */
export async function takeOverEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status !== "borrador") {
    throw conflict(
      locked.status === "anulada" ? "VOIDED" : "FINALIZED",
      "Solo se toma el relevo de una atención en curso",
    )
  }
  if (locked.professionalUserId === actorUserId) return locked
  const [row] = await tx
    .update(encounter)
    .set({ professionalUserId: actorUserId, updatedAt: new Date() })
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.taken_over", "encounter", encounterId, {
    patientId,
    from: locked.professionalUserId,
  })
  return row
}
