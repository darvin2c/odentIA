import { findHabitualMedication, HABITUAL_MEDICATIONS, normalizeDrugText, sameAllergyOnRecord, type HabitualMedicationEntry, medicationClassOf } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { encounter, encounterDictationSuggestion, patientAllergy } from "@odentia/db/schema/clinical"
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm"

/*
 * ---------- Lo que dijo de su salud y nadie confirmó, para lo que avisa ----------
 *
 * La receta, la exodoncia y la anestesia leían solo lo registrado en Antecedentes: con «dijo
 * apixabán, sin confirmar» en la franja, el ibuprofeno se recetaba sin aviso (QA del 21 nov, H2).
 * Lo dicho en la consulta (en la atención en curso, o en una ya firmada sin revisar) también avisa,
 * con esas palabras, sin frenar: decide quien atiende (ADR 0163). De un dato vale lo último que dijo.
 */

/** Una medicina que dijo que toma, sin confirmar. */
export interface SaidMedication {
  /** Su nombre tal como lo dijo; `null` si dijo que toma un anticoagulante y no cuál. */
  name: string | null
  atcCode: string | null
  /** Es un anticoagulante o un antiagregante (por su código, o porque lo dijo así). */
  anticoagulant: boolean
  /** Es una medicina para los huesos (bisfosfonatos, denosumab). */
  boneMedicine: boolean
  /** Cuándo lo dijo (ISO 8601). */
  at: string
  /** Su atención sigue en borrador: lo dijo en la consulta de hoy. Si no, en una ya firmada. */
  open: boolean
}

/** Lo que dijo de su salud sin confirmar que cambia una receta, una exodoncia o una anestesia. */
export interface SaidHealthRisks {
  medications: SaidMedication[]
  /** Lo que dijo del corazón y de la anestesia del dentista, con la forma de su entrevista. */
  dental: { corazon?: unknown; problemaAnestesia?: unknown; at: string; open: boolean } | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Lo que dice una propuesta de su salud (sin su `_meta`), en lo que avisa. Pura: la usa también la medición. */
export function saidHealthRisksOf(
  said: ReadonlyArray<{ payload: Record<string, unknown>; at: string; open: boolean }>,
  habitual: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): SaidHealthRisks {
  // De un dato vale lo último que dijo: lo de una consulta posterior reemplaza a lo de antes.
  const latest = new Map<string, { value: Record<string, unknown>; at: string; open: boolean }>()
  for (const item of said)
    for (const group of ["medications", "anticoagulants", "boneMedicines"] as const) {
      const value = item.payload[group]
      if (isRecord(value)) latest.set(group, { value, at: item.at, open: item.open })
    }
  const dental = [...said].reverse().find((item) => isRecord(item.payload["dental"]) && ("corazon" in (item.payload["dental"] as object) || "problemaAnestesia" in (item.payload["dental"] as object)))
  const medications: SaidMedication[] = []
  const medicines = latest.get("medications")
  if (medicines && medicines.value["state"] === "recorded" && Array.isArray(medicines.value["items"]))
    for (const item of medicines.value["items"] as unknown[]) {
      const name = isRecord(item) ? text(item["name"]) : ""
      if (!name) continue
      const atcCode = findHabitualMedication(name, habitual)?.atc ?? null
      const kind = medicationClassOf(atcCode)
      medications.push({ name, atcCode, anticoagulant: kind === "anticoagulants", boneMedicine: kind === "boneMedicines", at: medicines.at, open: medicines.open })
    }
  for (const group of ["anticoagulants", "boneMedicines"] as const) {
    const said = latest.get(group)
    // «Ya no la toma» no cambia el sangrado de hoy.
    if (!said || said.value["state"] !== "recorded" || said.value["now"] === false) continue
    const name = text(said.value["detail"]) || null
    const known = name ? medications.find((one) => one.name?.toLocaleLowerCase("es") === name.toLocaleLowerCase("es")) : undefined
    if (known) {
      known.anticoagulant ||= group === "anticoagulants"
      known.boneMedicine ||= group === "boneMedicines"
      continue
    }
    const atcCode = name ? (findHabitualMedication(name, habitual)?.atc ?? null) : null
    medications.push({ name, atcCode, anticoagulant: group === "anticoagulants", boneMedicine: group === "boneMedicines", at: said.at, open: said.open })
  }
  const answers = dental ? (dental.payload["dental"] as Record<string, unknown>) : null
  return {
    medications,
    dental: dental && answers ? { corazon: answers["corazon"], problemaAnestesia: answers["problemaAnestesia"], at: dental.at, open: dental.open } : null,
  }
}

/**
 * Lo que dijo de su salud en sus consultas (no anuladas) y sigue sin revisar, en lo que avisa
 * (`saidHealthRisksOf`). Lo lee quien ve la receta, la exodoncia o la anestesia de la persona.
 */
export async function saidHealthRisks(
  tx: Db,
  orgId: string,
  patientId: string,
  habitual: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): Promise<SaidHealthRisks> {
  const rows = await tx
    .select({ payload: encounterDictationSuggestion.payload, updatedAt: encounterDictationSuggestion.updatedAt, encounterStatus: encounter.status })
    .from(encounterDictationSuggestion)
    .innerJoin(encounter, and(eq(encounter.organizationId, encounterDictationSuggestion.organizationId), eq(encounter.id, encounterDictationSuggestion.encounterId)))
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.kind, "salud"),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
        inArray(encounter.status, ["borrador", "finalizada"]),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt))
  return saidHealthRisksOf(
    rows.map((row) => ({ payload: row.payload as Record<string, unknown>, at: row.updatedAt.toISOString(), open: row.encounterStatus === "borrador" })),
    habitual,
  )
}

/** Una alergia que propuso Clío y nadie confirmó: la sustancia como la dijo. */
export interface SaidAllergy {
  /** Su propuesta: con ella se registra o se deja de avisar en una atención firmada. */
  suggestionId: string
  /** Lo que se compara con la receta: la sustancia de la lista, o como la dijo. */
  substance: string
  substanceSystem: string | null
  substanceCode: string | null
  /** Cómo se dice en la franja: «ibuprofeno». */
  name: string
  severity: string | null
  /** Cuándo lo dijo (ISO 8601). */
  at: string
  /** Su atención sigue en borrador. Si no, ya se firmó sin revisarla. */
  open: boolean
}

/**
 * Las alergias que oyó Clío (propuestas de tipo `alergia`) y nadie confirmó ni descartó. La franja
 * no decía nada de ellas: con «ibuprofeno» propuesto, seguía en «Alergias: no se le preguntó», y la
 * receta del mismo ibuprofeno no avisaba (mesa del 25 nov, H2). Avisan como lo dicho, sin frenar.
 */
export async function saidAllergies(tx: Db, orgId: string, patientId: string): Promise<SaidAllergy[]> {
  const rows = await tx
    .select({ id: encounterDictationSuggestion.id, payload: encounterDictationSuggestion.payload, updatedAt: encounterDictationSuggestion.updatedAt, encounterStatus: encounter.status })
    .from(encounterDictationSuggestion)
    .innerJoin(encounter, and(eq(encounter.organizationId, encounterDictationSuggestion.organizationId), eq(encounter.id, encounterDictationSuggestion.encounterId)))
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.kind, "alergia"),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
        inArray(encounter.status, ["borrador", "finalizada"]),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt))
  // La que ya está en sus alergias (alguien la registró a mano) no pide revisión (QA del 25 nov).
  const registered = await tx
    .select({ substance: patientAllergy.substance, substanceCode: patientAllergy.substanceCode, verification: patientAllergy.verification })
    .from(patientAllergy)
    .where(and(eq(patientAllergy.organizationId, orgId), eq(patientAllergy.patientId, patientId), eq(patientAllergy.isActive, true)))
  const allergyKey = (code: string | null | undefined, substance: string) => (code || normalizeDrugText(substance)).toLocaleLowerCase("es")
  const seen = new Set<string>()
  const out: SaidAllergy[] = []
  for (const row of rows) {
    const payload = isRecord(row.payload) ? row.payload : {}
    const substance = text(payload["substance"]) || text(payload["name"])
    const name = text(payload["name"]) || substance
    const key = allergyKey(text(payload["substanceCode"]), substance)
    if (!substance || seen.has(key)) continue
    if (sameAllergyOnRecord({ substance, name, substanceCode: text(payload["substanceCode"]) || null }, registered)) continue
    seen.add(key)
    out.push({
      suggestionId: row.id,
      substance,
      substanceSystem: text(payload["substanceSystem"]) || null,
      substanceCode: text(payload["substanceCode"]) || null,
      name,
      severity: text(payload["severity"]) || null,
      at: row.updatedAt.toISOString(),
      open: row.encounterStatus === "borrador",
    })
  }
  return out
}

/**
 * Lo que no se descarta al firmar ni al cerrar sin revisarlo: lo dicho de su salud y una alergia con
 * su sustancia. Sigue avisándose con su fecha hasta que alguien lo revise (revisión del 21 nov, A3;
 * QA del 25 nov). Una sola regla para la firma (`finalizeEncounter`) y el cierre
 * (`discardPendingDictation`): en la QA, el cierre descartaba lo que la firma ya cuidaba.
 */
export function discardableWhenSigning(): SQL {
  return sql`not (${encounterDictationSuggestion.kind} = 'salud' or (${encounterDictationSuggestion.kind} = 'alergia' and coalesce(${encounterDictationSuggestion.payload}->>'substance', '') <> ''))`
}
