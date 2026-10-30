import {
  activeFindingsAsOf,
  type ClosingOdontogramPurpose,
  closingOdontogramPurpose,
  conditionLabel,
  type FindingDetails,
  type FindingInput,
  type FindingRecord,
  ISO_3950,
  MANUAL_SIGNED_ODONTOGRAM_PURPOSES,
  type SignedOdontogramPurpose,
  toothSiteCode,
  validateFinding,
} from "@odentia/dental"
import type { Db } from "@odentia/db"
import { encounterPlanItem, encounterSite, patient, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { odontogramAssessment, odontogramEntry, planItemFinding } from "@odentia/db/schema/dental"
import { branch, auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { requireDraftLink } from "../clinical.js"
import { organization } from "@odentia/db/schema/auth"
import { branchAddressColumns, branchAddressWriter } from "../branches.js"
import { documentCheckUrl } from "../document-check.js"
import { resolveOptionalDiagnosisCode } from "../diagnosis-codes.js"
import { notFound, ServiceError, validation } from "../errors.js"
import { orgDentalProfile } from "./profile.js"
import { requirePatient } from "../patients.js"
import { requireProfessionalSignature } from "../professional-profiles.js"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entity: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity, entityId, metadata: metadata ?? null })
}

// El odontograma (ADR 0036 y 0079): lo dental de la historia, fuera de lo
// común. Lo común no lo llama directo: lo pide al producto (`products.ts`).
// Numeración FDI y nomenclatura de la NTS 188 en todos los países; las siglas,
// la variante obligatoria y el odontograma firmado solo en clínicas de Perú
// (`orgDentalProfile`, ADR 0036 y 0079). La validación vive en `@odentia/clinical`
// (fail closed: condición desconocida, anatomía incompatible o datos
// faltantes = error); el servicio añade tenant, paciente, atención y CIE-10.
// Los hallazgos solo se registran dentro de una atención en borrador: así los
// firma quien la cierra (NTS 188, 5.3).

export interface AddOdontogramInput {
  toothNumber: number
  condition: string
  surfaces?: string[]
  details?: FindingDetails
  note?: string | null
  diagnosisCode?: string | null
  /** Lista del código; sin ella, la de la clínica. */
  diagnosisSystem?: string | null
  /** Atención en borrador donde se observa: obligatoria. */
  encounterId: string
}

type OdontogramRow = typeof odontogramEntry.$inferSelect

/** Normaliza relatedTeeth: enteros únicos ordenados incluyendo la principal. */
function normalizeRelatedTeeth(toothNumber: number, related?: unknown): number[] | null {
  if (!Array.isArray(related) || !related.length) return null
  const set = new Set<number>([toothNumber])
  for (const t of related) {
    if (typeof t === "number" && Number.isInteger(t)) set.add(t)
  }
  if (set.size < 2) return null
  return [...set].sort((a, b) => a - b)
}

function rowDetails(row: OdontogramRow): FindingDetails {
  const details = row.details as FindingDetails | null | undefined
  return { ...(details ?? {}) }
}

/** Proyección de estado de corrección sin mutar la fila original. */
function projectedStatus(row: OdontogramRow): string {
  if (row.voidedAt || row.status === "voided") return "voided"
  return row.status
}

function isVoidedRow(row: OdontogramRow): boolean {
  return row.voidedAt != null || row.status === "voided"
}

function toFindingRecord(row: OdontogramRow) {
  return { ...row, status: projectedStatus(row), details: rowDetails(row) }
}

/** Piezas cubiertas por un hallazgo (proyección multi-pieza vía relatedTeeth). */
function coveredTeeth(record: FindingRecord): number[] {
  const related = record.details?.relatedTeeth
  if (Array.isArray(related) && related.length > 1)
    return [...new Set(related)].sort((a, b) => a - b)
  return [record.toothNumber]
}

/** Con odontograma oficial (Perú) la variante es obligatoria; si no, opcional. */
export async function orgStrictVariants(tx: Db, orgId: string): Promise<boolean> {
  return (await orgDentalProfile(tx, orgId)).odontogram?.strictVariants ?? false
}

/**
 * Registra un hallazgo ya decidido en una atención en borrador que quien llama
 * ya comprobó: valida con la regla del país, inserta (una fila por superficie
 * o una sola para un hallazgo de grupo), suma la pieza a la atención y lo
 * audita. `leftByPlanItemId` es el tratamiento completado que lo dejó (se
 * escribe al insertar: la aplicación no reescribe un hallazgo). Solo para
 * servicios: el equipo registra con `addOdontogramEntries`.
 */
export async function insertOdontogramFinding(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: Omit<FindingInput, "encounterId"> & { diagnosisSystem?: string | null },
  options: { strictVariants: boolean; leftByPlanItemId?: string | null },
): Promise<OdontogramRow[]> {
  const finding: FindingInput = {
    toothNumber: input.toothNumber,
    condition: input.condition,
    surfaces: input.surfaces ?? [],
    details: input.details ?? {},
    note: input.note ?? null,
    diagnosisCode: input.diagnosisCode ?? null,
    encounterId,
  }
  const errors = validateFinding(finding, { strictVariants: options.strictVariants })
  if (errors.length) throw validation(errors.join("; "))
  const diagnosis = await resolveOptionalDiagnosisCode(tx, orgId, { code: input.diagnosisCode, system: input.diagnosisSystem })
  // Hallazgo de grupo/tramo (puente, dentadura, supernumerario): UNA sola fila
  // con relatedTeeth incluyendo la principal; se proyecta a cada participante.
  const related = normalizeRelatedTeeth(
    input.toothNumber,
    (input.details as { relatedTeeth?: unknown } | undefined)?.relatedTeeth,
  )
  const details: FindingDetails = { ...(input.details ?? {}) }
  if (related) details.relatedTeeth = related
  const surfaces = related ? [null] : (input.surfaces ?? []).length ? input.surfaces! : [null]
  const toInsert = surfaces.map((surface) => ({
    organizationId: orgId,
    patientId,
    toothNumber: input.toothNumber,
    surface,
    condition: input.condition,
    status: "recorded",
    ...diagnosis,
    note: input.note ?? null,
    details,
    needsReview: false,
    createdBy: actorUserId,
    encounterId,
    leftByPlanItemId: options.leftByPlanItemId ?? null,
  }))
  const rows = await tx.insert(odontogramEntry).values(toInsert).returning()
  const teethTouched = related ?? [input.toothNumber]
  for (const tooth of teethTouched) {
    await tx
      .insert(encounterSite)
      .values({ organizationId: orgId, encounterId, siteSystem: ISO_3950, siteCode: toothSiteCode(tooth) })
      .onConflictDoNothing()
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "odontogram.entry_added",
    "odontogram_entry",
    rows[0]?.id ?? patientId,
    {
      patientId,
      encounterId,
      toothNumber: input.toothNumber,
      relatedTeeth: teethTouched,
      count: rows.length,
      ...(options.leftByPlanItemId ? { leftByPlanItemId: options.leftByPlanItemId } : {}),
    },
  )
  return rows
}

/**
 * Registra un hallazgo observado en la atención en borrador de quien la lleva.
 * Sin atención no se registra: desde la ficha el odontograma se consulta y
 * «Atender» está a un clic.
 */
export async function addOdontogramEntries(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddOdontogramInput,
) {
  await requirePatient(tx, orgId, patientId)
  const encounterId = typeof input.encounterId === "string" ? input.encounterId.trim() : ""
  if (!encounterId) {
    throw new ServiceError(
      "ENCOUNTER_REQUIRED",
      400,
      "Los hallazgos se registran dentro de una atención: atiende a la persona para registrarlos",
    )
  }
  const row = await requireDraftLink(tx, orgId, patientId, encounterId)
  if (row.professionalUserId !== actorUserId) {
    throw conflict(
      "NOT_ATTENDING",
      "Otro profesional lleva esta atención: toma el relevo para continuarla",
    )
  }
  return insertOdontogramFinding(tx, orgId, actorUserId, patientId, encounterId, input, {
    strictVariants: await orgStrictVariants(tx, orgId),
  })
}

export async function voidOdontogramEntry(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entryId: string,
  patientId: string,
  reason: string,
) {
  const trimmed = reason?.trim() ?? ""
  if (!patientId) throw validation("patientId es obligatorio")
  if (!trimmed || trimmed.length > 2000)
    throw validation("El motivo de anulación es obligatorio (1–2000 caracteres)")
  const [current] = await tx
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.id, entryId), eq(odontogramEntry.organizationId, orgId)))
    .limit(1)
  if (!current || current.patientId !== patientId) throw notFound("Entrada de odontograma")
  if (current.encounterId) await requireDraftLink(tx, orgId, current.patientId, current.encounterId)
  if (isVoidedRow(current)) throw conflict("ALREADY_VOIDED", "La entrada ya está anulada")
  // Corrección auditable: solo estado de corrección; condition/surface/note
  // originales se preservan intactos.
  const [updated] = await tx
    .update(odontogramEntry)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: trimmed,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(odontogramEntry.id, entryId),
        eq(odontogramEntry.status, "recorded"),
        sql`${odontogramEntry.voidedAt} is null`,
      ),
    )
    .returning()
  if (!updated) throw conflict("ALREADY_VOIDED", "La entrada ya está anulada")
  await audit(tx, orgId, actorUserId, "odontogram.entry_voided", "odontogram_entry", entryId, {
    patientId: current.patientId,
    reason: trimmed,
  })
  return { ...updated, status: projectedStatus(updated) }
}

/**
 * Revisión de legado migrado: solo puede anularse con motivo (sin inventar
 * datos); el registro corregido se crea aparte con addOdontogramEntries.
 */
export async function reviewLegacyEntry(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  entryId: string,
  reason: string,
) {
  const [current] = await tx
    .select({
      id: odontogramEntry.id,
      patientId: odontogramEntry.patientId,
      needsReview: odontogramEntry.needsReview,
    })
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.id, entryId), eq(odontogramEntry.organizationId, orgId)))
    .limit(1)
  if (!current || current.patientId !== patientId) throw notFound("Entrada de odontograma")
  if (!current.needsReview)
    throw conflict("NOT_LEGACY", "La entrada no requiere revisión de legado")
  const updated = await voidOdontogramEntry(tx, orgId, actorUserId, entryId, patientId, reason)
  await audit(tx, orgId, actorUserId, "odontogram.legacy_reviewed", "odontogram_entry", entryId, {
    patientId,
  })
  return updated
}

export interface ToothState {
  condition: string
  status: string
  surfaces: string[]
  entries: string[]
}

export async function getOdontogram(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.patientId, patientId), eq(odontogramEntry.organizationId, orgId)))
    .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id))
  const history = rows.map((row) => ({ ...row, status: projectedStatus(row) }))
  // Activos: append-only, coexisten todas las condiciones registradas;
  // Excluye registros pendientes de revisión y correcciones vigentes.
  const candidates = rows.filter((row) => !row.needsReview && !isVoidedRow(row))
  const active = activeFindingsAsOf(candidates.map(toFindingRecord))
  const byTooth = new Map<number, FindingRecord[]>()
  for (const entry of active) {
    for (const tooth of coveredTeeth(entry)) {
      const list = byTooth.get(tooth) ?? []
      list.push(entry)
      byTooth.set(tooth, list)
    }
  }
  const teeth: Record<string, ToothState> = {}
  for (const [tooth, entries] of byTooth) {
    const latest = entries[entries.length - 1]!
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: [...new Set(entries.map((e) => e.surface).filter((s): s is string => !!s))].sort(),
      entries: entries.map((e) => e.id),
    }
  }
  return { teeth, history }
}

// --- Odontograma firmado (solo en clínicas de Perú; ADR 0036) ---
//
// Una sola firma, la del perfil profesional, sin trazo: nombre, título y
// colegiatura salen del perfil de quien firma, nunca del cuerpo. El cierre de
// una atención que cambió el gráfico lo firma solo, con su momento deducido
// (inicio del plan, nuevos hallazgos o culminación; NTS 188, 5.10); el botón
// «Firmar odontograma» queda para lo judicial, lo personal y el reingreso
// (5.11). Cada uno guarda su norma: cambiar el país no la reescribe.

/** Lo que se pide al pulsar «Firmar odontograma»: el momento y, si hace falta, notas. */
export interface CreateAssessmentInput {
  purpose: string
  specifications?: string | null
  observations?: string | null
}

export type OdontogramAssessmentRow = typeof odontogramAssessment.$inferSelect

/** Inserta el odontograma firmado con la instantánea de hallazgos vigentes. */
async function signOdontogram(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: {
    purpose: SignedOdontogramPurpose
    specifications: string
    observations: string
    encounterId: string | null
    standard: string
    signer: { name: string; title: string; registration: string }
  },
): Promise<OdontogramAssessmentRow> {
  const patientRow = await requirePatient(tx, orgId, patientId)
  // Identidad firmada desde el servidor (nunca del body del cliente).
  const patientName = patientRow.displayName.trim()
  if (!patientName) throw validation("La persona no tiene nombre registrado para firmar el odontograma")
  // Snapshot calculado en el servidor; nunca se acepta del cliente.
  const { history } = await getOdontogram(tx, orgId, patientId)
  const candidates = history.filter((row) => !row.needsReview && !isVoidedRow(row))
  const entries = activeFindingsAsOf(candidates.map(toFindingRecord))
  const [row] = await tx
    .insert(odontogramAssessment)
    .values({
      organizationId: orgId,
      patientId,
      authorUserId: actorUserId,
      purpose: input.purpose,
      specifications: input.specifications,
      observations: input.observations,
      examinerName: input.signer.name,
      examinerTitle: input.signer.title,
      registrationNumber: input.signer.registration,
      patientName,
      patientNumber: patientRow.patientNumber,
      entries,
      standard: input.standard,
      encounterId: input.encounterId,
    })
    .returning()
  if (!row) throw notFound("Odontograma firmado")
  await audit(
    tx,
    orgId,
    actorUserId,
    "odontogram.assessment_sealed",
    "odontogram_assessment",
    row.id,
    {
      patientId,
      purpose: input.purpose,
      encounterId: input.encounterId,
      entriesCount: entries.length,
    },
  )
  return row
}

function cleanAssessmentText(value: string | null | undefined, field: string): string {
  const text = value?.trim() ?? ""
  if (text.length > 4000) throw validation(`${field} admite hasta 4000 caracteres`)
  return text
}

/**
 * «Firmar odontograma»: a pedido judicial, a pedido de la persona o al
 * reingresar tras culminar el plan (NTS 188, 5.10 y 5.11). Los demás momentos
 * los firma el cierre de la atención. Solo en clínicas con odontograma
 * oficial; quien firma lo hace con su perfil (sin colegiatura no se firma).
 */
export async function createOdontogramAssessment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateAssessmentInput,
): Promise<OdontogramAssessmentRow> {
  await requirePatient(tx, orgId, patientId)
  const official = (await orgDentalProfile(tx, orgId)).odontogram
  if (!official?.signedOdontogram) {
    throw new ServiceError(
      "SIGNED_ODONTOGRAM_UNAVAILABLE",
      409,
      "En las clínicas de este país el odontograma no se firma: imprímelo desde Clínica › Odontograma",
    )
  }
  if (!(MANUAL_SIGNED_ODONTOGRAM_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw validation(
      "Con «Firmar odontograma» se firma a pedido judicial, a pedido de la persona o al reingresar; el inicio, los nuevos hallazgos y la culminación los firma el cierre de la atención",
    )
  }
  const specifications = cleanAssessmentText(input.specifications, "Las especificaciones")
  const observations = cleanAssessmentText(input.observations, "Las observaciones")
  // Firma con su perfil: sin colegiatura no se firma (nadie firma con otro nombre).
  const signer = await requireProfessionalSignature(tx, orgId, actorUserId)
  // Sin firma sobre revisión pendiente: primero se revisan los legados.
  const [pending] = await tx
    .select({ id: odontogramEntry.id })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.needsReview, true),
        sql`${odontogramEntry.voidedAt} IS NULL`,
        sql`${odontogramEntry.status} <> 'voided'`,
      ),
    )
    .limit(1)
  if (pending)
    throw conflict(
      "NEEDS_REVIEW",
      "Hay hallazgos anteriores pendientes de revisión: revísalos antes de firmar el odontograma",
    )
  return signOdontogram(tx, orgId, actorUserId, patientId, {
    purpose: input.purpose as SignedOdontogramPurpose,
    specifications,
    observations,
    encounterId: null,
    standard: official.standard,
    signer,
  })
}

export async function listOdontogramAssessments(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  return tx
    .select()
    .from(odontogramAssessment)
    .where(
      and(
        eq(odontogramAssessment.patientId, patientId),
        eq(odontogramAssessment.organizationId, orgId),
      ),
    )
    .orderBy(desc(odontogramAssessment.createdAt), desc(odontogramAssessment.id))
}

/** Lo que dejó una atención en el gráfico, por hallazgo: «caries en 16, 26 y 36». */
export interface EncounterFindingGroup {
  condition: string
  teeth: number[]
}

/** El odontograma que firmará el cierre de la atención (solo en clínicas de Perú). */
export interface ClosingOdontogram {
  purpose: ClosingOdontogramPurpose
  /** Norma con la que se firma («NTS 188-MINSA/DGIESP-2022») y su nombre corto. */
  standard: string
  shortName: string
  /** Lo que se registró en esta atención; vacío si solo quedó tratado lo anterior. */
  findings: EncounterFindingGroup[]
}

/**
 * Si el cierre de esta atención firma el odontograma y con qué momento: solo
 * en clínicas con odontograma firmado y si la atención cambió el gráfico (un
 * hallazgo nuevo vigente, o uno anterior que su tratamiento deja tratado al
 * cerrar). La misma regla sirve al cierre (antes de firmar, para decirlo) y a
 * `finalizeEncounter` (al firmar).
 */
export async function closingOdontogramOf(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<ClosingOdontogram | null> {
  const official = (await orgDentalProfile(tx, orgId)).odontogram
  if (!official?.signedOdontogram) return null
  const added = await tx
    .select({
      condition: odontogramEntry.condition,
      toothNumber: odontogramEntry.toothNumber,
      details: odontogramEntry.details,
    })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.encounterId, encounterId),
        isNull(odontogramEntry.voidedAt),
        sql`${odontogramEntry.status} <> 'voided'`,
        eq(odontogramEntry.needsReview, false),
      ),
    )
    .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id))
  // Lo realizado en esta atención: deja tratado su hallazgo y puede culminar el plan.
  const done = await tx
    .select({
      planId: treatmentPlanItem.planId,
      entryId: planItemFinding.odontogramEntryId,
      itemId: treatmentPlanItem.id,
    })
    .from(encounterPlanItem)
    .innerJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, encounterPlanItem.planItemId),
        eq(treatmentPlanItem.organizationId, encounterPlanItem.organizationId),
      ),
    )
    .leftJoin(planItemFinding, eq(planItemFinding.planItemId, treatmentPlanItem.id))
    .where(
      and(
        eq(encounterPlanItem.organizationId, orgId),
        eq(encounterPlanItem.encounterId, encounterId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.status, "realizado"),
      ),
    )
  const treatedIds = done.flatMap((item) => (item.entryId ? [item.entryId] : []))
  const treated = treatedIds.length
    ? await tx
        .select({ id: odontogramEntry.id })
        .from(odontogramEntry)
        .where(
          and(
            eq(odontogramEntry.organizationId, orgId),
            inArray(odontogramEntry.id, treatedIds),
            isNull(odontogramEntry.voidedAt),
            or(
              isNull(odontogramEntry.resolvedAt),
              inArray(
                odontogramEntry.resolvedByPlanItemId,
                done.map((item) => item.itemId),
              ),
            ),
          ),
        )
    : []
  if (added.length === 0 && treated.length === 0) return null
  const previous = await tx
    .select({ purpose: odontogramAssessment.purpose })
    .from(odontogramAssessment)
    .where(
      and(
        eq(odontogramAssessment.organizationId, orgId),
        eq(odontogramAssessment.patientId, patientId),
      ),
    )
    .orderBy(asc(odontogramAssessment.createdAt), asc(odontogramAssessment.id))
  // Culmina el plan si a alguno de los planes de lo realizado hoy ya no le
  // queda nada por hacer (todo realizado, cancelado o reemplazado).
  const planIds = [...new Set(done.map((item) => item.planId))]
  const open = planIds.length
    ? await tx
        .select({ planId: treatmentPlanItem.planId })
        .from(treatmentPlanItem)
        .where(
          and(
            eq(treatmentPlanItem.organizationId, orgId),
            eq(treatmentPlanItem.patientId, patientId),
            inArray(treatmentPlanItem.planId, planIds),
            sql`${treatmentPlanItem.status} not in ('realizado', 'cancelado', 'reemplazado')`,
          ),
        )
    : []
  const stillOpen = new Set(open.map((row) => row.planId))
  const culminated = planIds.some((planId) => !stillOpen.has(planId))
  const groups = new Map<string, Set<number>>()
  for (const entry of added) {
    const teeth = groups.get(entry.condition) ?? new Set<number>()
    const related = (entry.details as FindingDetails | null)?.relatedTeeth
    for (const tooth of related?.length ? related : [entry.toothNumber]) teeth.add(tooth)
    groups.set(entry.condition, teeth)
  }
  return {
    purpose: closingOdontogramPurpose(
      previous.map((row) => row.purpose),
      culminated,
    ),
    standard: official.standard,
    shortName: official.shortName,
    findings: [...groups].map(([condition, teeth]) => ({
      condition,
      teeth: [...teeth].sort((a, b) => a - b),
    })),
  }
}

/**
 * Al cerrar la atención (dentro de `finalizeEncounter`, después de dejar
 * tratado lo realizado): firma el odontograma con el perfil de quien cierra,
 * si la atención cambió el gráfico en una clínica de Perú. Uno por atención.
 */
export async function signClosingOdontogram(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  signer: { name: string; title: string; registration: string },
): Promise<OdontogramAssessmentRow | null> {
  const closing = await closingOdontogramOf(tx, orgId, patientId, encounterId)
  if (!closing) return null
  return signOdontogram(tx, orgId, actorUserId, patientId, {
    purpose: closing.purpose,
    specifications: "",
    observations: "",
    encounterId,
    standard: closing.standard,
    signer,
  })
}

/** Datos de la clínica que encabezan una hoja impresa. */
async function establishmentOf(tx: Db, orgId: string) {
  const [org] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      fiscalDocType: orgProfile.fiscalDocType,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      address: orgProfile.fiscalAddress,
      logo: organization.logo,
    })
    .from(orgProfile)
    .leftJoin(organization, eq(organization.id, orgProfile.organizationId))
    .where(eq(orgProfile.organizationId, orgId))
  if (!org) return null
  // Como los demás papeles: con una sola sede, su nombre, dirección y teléfono.
  const branches = await tx
    .select({ name: branch.name, address: branchAddressColumns, phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .limit(2)
  const only = branches.length === 1 ? branches[0]! : null
  return {
    ...org,
    address: (only ? (await branchAddressWriter(tx, orgId))(only.address) : null) ?? org.address,
    branchName: only?.name ?? null,
    phone: only?.phone ?? null,
  }
}

async function printPatientOf(tx: Db, orgId: string, patientId: string) {
  const row = await requirePatient(tx, orgId, patientId)
  return {
    displayName: row.displayName,
    patientNumber: row.patientNumber,
    docType: row.docType,
    docNumber: row.docNumber,
    birthDate: row.birthDate,
  }
}

/**
 * Hoja de un odontograma firmado para ver e imprimir: su instantánea con el
 * gráfico de la norma, quién lo firmó y «Firma y sello» para el papel.
 */
export async function getSignedOdontogramPrint(
  tx: Db,
  orgId: string,
  patientId: string,
  assessmentId: string,
) {
  const [assessment] = await tx
    .select()
    .from(odontogramAssessment)
    .where(
      and(
        eq(odontogramAssessment.id, assessmentId),
        eq(odontogramAssessment.organizationId, orgId),
        eq(odontogramAssessment.patientId, patientId),
      ),
    )
    .limit(1)
  if (!assessment) throw notFound("Odontograma firmado")
  return {
    assessment,
    patient: await printPatientOf(tx, orgId, patientId),
    establishment: await establishmentOf(tx, orgId),
    // La dirección del QR de la hoja: quien la tiene en la mano comprueba que sigue vigente.
    checkUrl: await documentCheckUrl(tx, orgId, "signed_odontogram", assessment.id),
  }
}

/**
 * El odontograma vigente en palabras, por pieza, para la copia de la historia
 * (ADR 0080). Vive aquí para que la copia no importe lo dental (ADR 0079).
 */
export async function odontogramLines(tx: Db, orgId: string, patientId: string) {
  const { teeth } = await getOdontogram(tx, orgId, patientId)
  return Object.entries(teeth)
    .map(([tooth, state]) => ({ tooth: Number(tooth), label: conditionLabel(state.condition), surfaces: state.surfaces }))
    .sort((a, b) => a.tooth - b.tooth)
}

/**
 * Hoja neutra del odontograma de hoy, sin norma de ningún país: numeración FDI
 * y los hallazgos vigentes por pieza. Es lo que se imprime donde no hay
 * odontograma firmado.
 */
export async function getOdontogramPrint(tx: Db, orgId: string, patientId: string) {
  const patientRow = await printPatientOf(tx, orgId, patientId)
  const { history } = await getOdontogram(tx, orgId, patientId)
  const candidates = history.filter((row) => !row.needsReview && !isVoidedRow(row))
  return {
    entries: activeFindingsAsOf(candidates.map(toFindingRecord)),
    patient: patientRow,
    establishment: await establishmentOf(tx, orgId),
    printedAt: new Date(),
  }
}

