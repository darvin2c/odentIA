/**
 * Alergias una por una (issue 43, tablero 7 del lienzo de Pacientes, ADR 0072):
 * agregar con la sustancia de la lista, quitar con motivo (nunca se borra),
 * volver a ponerla, elegir de la lista lo escrito a mano y dejar constancia de
 * que se revisaron con el paciente. Cada operación avanza la revisión del
 * agregado de salud, así una edición abierta de Antecedentes recarga en vez de
 * pisarla, y cuenta como revisión de las alergias.
 */
import {
  ALLERGY_REMOVAL_REASONS,
  ALLERGY_SEVERITIES,
  type AllergenEntry,
  type AllergyRemovalReason,
  allergenByCode,
  allergenName,
  codeAllergySubstance,
  normalizeDrugText,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patient, patientAllergy } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, ne } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { productHooks } from "./products.js"

/** Pasado este plazo sin revisarlas, la atención pide preguntarle si tiene alergias nuevas. */
export const ALLERGY_REVIEW_MONTHS = 6

/** Si toca preguntarle por sus alergias: nunca se revisaron o pasaron 6 meses. */
export function allergyReviewDue(reviewedAt: Date | null, now: Date = new Date()): boolean {
  if (!reviewedAt) return true
  const due = new Date(reviewedAt)
  due.setUTCMonth(due.getUTCMonth() + ALLERGY_REVIEW_MONTHS)
  return due <= now
}

export type PatientAllergyRow = typeof patientAllergy.$inferSelect

export interface AllergySubstanceInput {
  /** Lo escrito; si viene la lista y el código, se toma el nombre de la lista. */
  substance?: string | null
  substanceSystem?: string | null
  substanceCode?: string | null
}

export interface AddAllergyInput extends AllergySubstanceInput {
  /** «¿Qué tan fuerte fue la reacción?»; sin dato, «desconocida» (igual avisa). */
  severity?: string | null
  /** «Qué le pasó», opcional. */
  reaction?: string | null
}

interface ResolvedSubstance {
  substance: string
  entry: AllergenEntry | null
}

/**
 * La sustancia elegida de la lista, o lo escrito: si es exactamente una de la
 * lista («Penicilina»), queda con su código; si no («amoxi»), sin codificar.
 */
function resolveSubstance(input: AllergySubstanceInput, allergens: readonly AllergenEntry[]): ResolvedSubstance {
  if (input.substanceSystem || input.substanceCode) {
    const entry = allergenByCode(input.substanceSystem, input.substanceCode, allergens)
    if (!entry) throw validation("Elige la sustancia de la lista")
    return { substance: entry.label, entry }
  }
  const text = input.substance?.trim().replace(/\s+/g, " ") ?? ""
  if (!text) throw validation("Escribe o elige la sustancia")
  if (text.length > 200) throw validation("La sustancia debe tener hasta 200 caracteres")
  const entry = codeAllergySubstance(text, allergens)
  return { substance: entry ? entry.label : text, entry }
}

/** Cómo se nombra en un mensaje: «la alergia a penicilinas», «la alergia a «amoxi»». */
function nameOf(
  row: {
    substance: string
    substanceSystem: string | null
    substanceCode: string | null
  },
  allergens: readonly AllergenEntry[],
): string {
  const entry = allergenByCode(row.substanceSystem, row.substanceCode, allergens)
  return entry ? allergenName(entry) : `«${row.substance}»`
}

/** Las sustancias de alergia del producto de la clínica (issue 229: latidIA suma la medicina general). */
async function allergensOf(tx: Db, orgId: string): Promise<readonly AllergenEntry[]> {
  return (await productHooks(tx, orgId)).prescribing.catalog.allergens
}

async function lockHealth(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const [locked] = await tx
    .select({ revision: patient.healthRevision, reviewStatus: patient.healthReviewStatus })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!locked) throw notFound("Paciente")
  return locked
}

async function activeAllergies(tx: Db, orgId: string, patientId: string, exceptId?: string) {
  return tx
    .select()
    .from(patientAllergy)
    .where(
      and(
        eq(patientAllergy.organizationId, orgId),
        eq(patientAllergy.patientId, patientId),
        eq(patientAllergy.isActive, true),
        ...(exceptId ? [ne(patientAllergy.id, exceptId)] : []),
      ),
    )
}

/** Una alergia vigente que ya dice lo mismo: el mismo código o, sin código, el mismo texto. */
function sameAllergy(
  rows: PatientAllergyRow[],
  substance: ResolvedSubstance,
): PatientAllergyRow | undefined {
  return rows.find((row) =>
    substance.entry
      ? row.substanceSystem === substance.entry.system && row.substanceCode === substance.entry.code
      : !row.substanceCode &&
        normalizeDrugText(row.substance) === normalizeDrugText(substance.substance),
  )
}

async function requireAllergy(
  tx: Db,
  orgId: string,
  patientId: string,
  allergyId: string,
): Promise<PatientAllergyRow> {
  const [row] = await tx
    .select()
    .from(patientAllergy)
    .where(
      and(
        eq(patientAllergy.id, allergyId),
        eq(patientAllergy.organizationId, orgId),
        eq(patientAllergy.patientId, patientId),
      ),
    )
    .limit(1)
    .for("update")
  if (!row) throw notFound("Alergia")
  return row
}

/**
 * Avanza la revisión del agregado y deja la revisión de las alergias a nombre
 * de quien actuó. Con alergias vigentes el grupo queda «registrado» (la misma
 * regla del agregado); revisarlas sin ninguna vigente es «no tiene».
 */
async function touchHealth(
  tx: Db,
  orgId: string,
  patientId: string,
  actorUserId: string,
  locked: { revision: number; reviewStatus: unknown },
  allergiesState: "recorded" | "none" | "keep",
): Promise<void> {
  const reviewStatus = { ...((locked.reviewStatus ?? {}) as Record<string, unknown>) }
  const now = new Date()
  await tx
    .update(patient)
    .set({
      healthRevision: locked.revision + 1,
      healthReviewStatus: {
        allergies:
          allergiesState === "keep" ? (reviewStatus.allergies ?? "unknown") : allergiesState,
        conditions: reviewStatus.conditions ?? "unknown",
        medications: reviewStatus.medications ?? "unknown",
      },
      allergiesReviewedAt: now,
      allergiesReviewedBy: actorUserId,
      updatedAt: now,
    })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  patientId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Sin copiar el dato clínico: la auditoría dice qué pasó y con qué código.
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "patient",
    entityId: patientId,
    metadata,
  })
}

/** «Nueva alergia»: la sustancia, qué tan fuerte fue y, si se sabe, qué le pasó. */
export async function addPatientAllergy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddAllergyInput,
): Promise<PatientAllergyRow> {
  const allergens = await allergensOf(tx, orgId)
  const substance = resolveSubstance(input, allergens)
  const severity = input.severity?.trim() || "desconocida"
  if (!(ALLERGY_SEVERITIES as readonly string[]).includes(severity))
    throw validation("Elige qué tan fuerte fue la reacción: leve, moderada, severa o no se sabe")
  const reaction = input.reaction?.trim() || null
  if (reaction && reaction.length > 2000)
    throw validation("Lo que le pasó debe tener hasta 2000 caracteres")
  const locked = await lockHealth(tx, orgId, patientId)
  const existing = sameAllergy(await activeAllergies(tx, orgId, patientId), substance)
  if (existing)
    throw new ServiceError(
      "ALLERGY_EXISTS",
      409,
      `Ya tiene registrada la alergia a ${nameOf(existing, allergens)}.`,
    )
  const [row] = await tx
    .insert(patientAllergy)
    .values({
      organizationId: orgId,
      patientId,
      substance: substance.substance,
      substanceSystem: substance.entry?.system ?? null,
      substanceCode: substance.entry?.code ?? null,
      category: substance.entry?.category ?? null,
      reaction,
      severity,
      kind: "alergia",
      source: "equipo",
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la alergia")
  await touchHealth(tx, orgId, patientId, actorUserId, locked, "recorded")
  await audit(tx, orgId, actorUserId, "health.allergy_added", patientId, {
    allergyId: row.id,
    coded: Boolean(row.substanceCode),
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return row
}

/**
 * «Quitar» (solo quien escribe en la historia), con su motivo. Deja de avisar
 * al recetar, pero no se borra: queda en «Alergias quitadas» y se puede volver
 * a poner.
 */
export async function removePatientAllergy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  allergyId: string,
  reason: string,
): Promise<PatientAllergyRow> {
  if (!(ALLERGY_REMOVAL_REASONS as readonly string[]).includes(reason))
    throw validation(
      "Elige por qué se quita: ya no es alérgica, era otra cosa o se registró por error",
    )
  const locked = await lockHealth(tx, orgId, patientId)
  const current = await requireAllergy(tx, orgId, patientId, allergyId)
  if (!current.isActive)
    throw new ServiceError("ALLERGY_ALREADY_REMOVED", 409, "Esa alergia ya estaba quitada.")
  const now = new Date()
  const [row] = await tx
    .update(patientAllergy)
    .set({
      isActive: false,
      removedReason: reason as AllergyRemovalReason,
      removedAt: now,
      removedBy: actorUserId,
      updatedAt: now,
    })
    .where(and(eq(patientAllergy.id, allergyId), eq(patientAllergy.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Alergia")
  await touchHealth(tx, orgId, patientId, actorUserId, locked, "keep")
  await audit(tx, orgId, actorUserId, "health.allergy_removed", patientId, {
    allergyId,
    reason,
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return row
}

/** «Volver a ponerla» o «Deshacer»: la alergia quitada vuelve a avisar. */
export async function restorePatientAllergy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  allergyId: string,
): Promise<PatientAllergyRow> {
  const locked = await lockHealth(tx, orgId, patientId)
  const current = await requireAllergy(tx, orgId, patientId, allergyId)
  if (current.isActive) throw new ServiceError("ALLERGY_ACTIVE", 409, "Esa alergia ya está puesta.")
  const allergens = await allergensOf(tx, orgId)
  const resolved: ResolvedSubstance = {
    substance: current.substance,
    entry: allergenByCode(current.substanceSystem, current.substanceCode, allergens),
  }
  const existing = sameAllergy(await activeAllergies(tx, orgId, patientId), resolved)
  if (existing)
    throw new ServiceError(
      "ALLERGY_EXISTS",
      409,
      `Ya tiene registrada la alergia a ${nameOf(existing, allergens)}.`,
    )
  const [row] = await tx
    .update(patientAllergy)
    .set({
      isActive: true,
      removedReason: null,
      removedAt: null,
      removedBy: null,
      // Una descartada de antes del cambio vuelve como cualquier otra: avisa.
      ...(current.verification === "descartada" ? { verification: "no_confirmada" } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(patientAllergy.id, allergyId), eq(patientAllergy.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Alergia")
  await touchHealth(tx, orgId, patientId, actorUserId, locked, "recorded")
  await audit(tx, orgId, actorUserId, "health.allergy_restored", patientId, {
    allergyId,
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return row
}

/**
 * «Elegir de la lista» para una alergia escrita a mano: agrega el código y
 * conserva lo que se escribió.
 */
export async function codePatientAllergy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  allergyId: string,
  input: { substanceSystem: string; substanceCode: string },
): Promise<PatientAllergyRow> {
  const allergens = await allergensOf(tx, orgId)
  const entry = allergenByCode(input.substanceSystem, input.substanceCode, allergens)
  if (!entry) throw validation("Elige la sustancia de la lista")
  const locked = await lockHealth(tx, orgId, patientId)
  const current = await requireAllergy(tx, orgId, patientId, allergyId)
  if (current.substanceCode)
    throw new ServiceError("ALLERGY_ALREADY_CODED", 409, "Esa alergia ya está elegida de la lista.")
  if (current.isActive) {
    const existing = sameAllergy(await activeAllergies(tx, orgId, patientId, allergyId), {
      substance: entry.label,
      entry,
    })
    if (existing)
      throw new ServiceError(
        "ALLERGY_EXISTS",
        409,
        `Ya tiene registrada la alergia a ${nameOf(existing, allergens)}: quita esta, que está repetida.`,
      )
  }
  const [row] = await tx
    .update(patientAllergy)
    .set({
      substanceSystem: entry.system,
      substanceCode: entry.code,
      category: current.category ?? entry.category,
      updatedAt: new Date(),
    })
    .where(and(eq(patientAllergy.id, allergyId), eq(patientAllergy.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Alergia")
  await touchHealth(tx, orgId, patientId, actorUserId, locked, "keep")
  await audit(tx, orgId, actorUserId, "health.allergy_coded", patientId, {
    allergyId,
    substance: `${entry.system}:${entry.code}`,
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return row
}

/**
 * «Sin cambios»: se le preguntó y sus alergias siguen igual. Sin ninguna
 * vigente, queda dicho que no tiene («No tiene alergias»).
 */
export async function markAllergiesReviewed(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
): Promise<{ reviewedAt: Date }> {
  const locked = await lockHealth(tx, orgId, patientId)
  const active = await activeAllergies(tx, orgId, patientId)
  await touchHealth(
    tx,
    orgId,
    patientId,
    actorUserId,
    locked,
    active.length > 0 ? "recorded" : "none",
  )
  await audit(tx, orgId, actorUserId, "health.allergies_reviewed", patientId, {
    active: active.length,
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return { reviewedAt: new Date() }
}
