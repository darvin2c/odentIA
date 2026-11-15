/**
 * Lo que la atención firmada guarda de lo que se dijo de su salud y nadie revisó (auditor, 15 nov,
 * A2): el cierre lo avisaba («Sin revisar: lo que dijo ella de su salud el 14 nov. Se firma igual.»)
 * y no quedaba constancia. Al firmar, `finalizeEncounter` guarda una foto por declaración: quién lo
 * dijo y cuándo (de `PatientHealth.declared`) y qué, dato por dato, con las palabras de «Revisa con
 * … lo que dijo de su salud». La pantalla y la copia solo la escriben; nunca frena la firma.
 */
import {
  type HealthAtSigning,
  type InterviewEntry,
  isCurrentMedication,
  MEDICATION_CLASSES,
  type MedicationClass,
  medicationClassOf,
  type PregnancyToday,
  saidNoWords,
  weeksWords,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { type DeclaredHealthGroup, ENTRY_DECLARED_KEYS, getPatientHealth, type PatientHealth } from "./clinical.js"
import type { ProductInterview } from "./product-hooks.js"

type Row = HealthAtSigning["rows"][number]

/** El embarazo al firmar: las semanas de ese día; pasado su término ya no se afirma. */
function pregnancyValue(pregnancy: PregnancyToday): string {
  if (pregnancy.state === "por_confirmar") return "por confirmar: ya pasó el tiempo de un embarazo"
  return pregnancy.weeksToday === null ? "sí, sin las semanas" : `${weeksWords(pregnancy.weeksToday)} al firmar`
}

/**
 * Lo de una declaración sin revisar, dato por dato, en palabras. `last`: es la última, la que dice
 * el «No» o el «No sé» a cada clase de medicina; `interview`, la entrevista guardada en palabras.
 */
export function healthAtSigningRows(
  health: Pick<PatientHealth, "allergies" | "conditions" | "medications" | "medicineClasses" | "pregnancy">,
  group: DeclaredHealthGroup,
  context: { sex: string | null; today: string; last: boolean; interview: readonly InterviewEntry[] },
): Row[] {
  const no = saidNoWords(group.by, context.sex).toLocaleLowerCase("es")
  const rows: Row[] = []
  if (group.pregnancy && health.pregnancy) rows.push({ label: "Embarazo", value: pregnancyValue(health.pregnancy) })
  // Lo que dijo, como lo escribió: «Penicilina», no el nombre del grupo de la lista.
  const allergies = health.allergies.filter((row) => group.allergies.includes(row.id))
  if (allergies.length > 0)
    rows.push({
      label: "Alergias",
      value: allergies
        .map((row) => [row.substance, row.severity === "desconocida" ? null : row.severity, row.reaction?.trim()].filter(Boolean).join(" · "))
        .join("; "),
    })
  else if (group.saidNo.allergies) rows.push({ label: "Alergias", value: no })
  const medications = health.medications.filter((row) => group.medications.includes(row.id) && isCurrentMedication(row, context.today))
  // Lo que tiene marca (anticoagulante, huesos) va en su propia fila, como arriba de la ficha.
  for (const key of Object.keys(MEDICATION_CLASSES) as MedicationClass[]) {
    const { label, unnamed } = MEDICATION_CLASSES[key]
    const inClass = medications.filter((row) => medicationClassOf(row.atcCode) === key)
    if (inClass.length > 0)
      rows.push({
        label,
        value: inClass.map((row) => (row.name === unnamed ? "no dijo cuál" : [row.name, row.dose].filter(Boolean).join(" "))).join(", "),
      })
    else if (context.last) {
      const known = health.medicineClasses[key]
      if (known.said && known.answer === "unknown") rows.push({ label, value: "no sabe" })
      else if (known.said && known.answer === "no") rows.push({ label, value: no })
    }
  }
  const others = medications.filter((row) => medicationClassOf(row.atcCode) === null)
  if (others.length > 0) rows.push({ label: "Medicinas", value: others.map((row) => row.name).join(", ") })
  else if (medications.length === 0 && group.saidNo.medications) rows.push({ label: "Medicinas", value: no })
  const conditions = health.conditions.filter((row) => group.conditions.includes(row.id) && row.status === "activa")
  if (conditions.length > 0) rows.push({ label: "Enfermedades", value: conditions.map((row) => row.name).join(", ") })
  else if (group.saidNo.conditions) rows.push({ label: "Enfermedades", value: no })
  // El corazón, la anestesia, el tabaco y la lactancia que dijo, con las palabras de la copia.
  for (const entry of context.interview)
    if ((ENTRY_DECLARED_KEYS[entry.key] ?? []).some((key) => group.interview.includes(key)))
      rows.push({ label: entry.label, value: entry.value })
  rows.push(...group.productLines)
  return rows
}

/**
 * La foto al firmar: una por declaración que aún dice algo; vacía si no queda nada sin revisar.
 * Lo que la firma ya sabe (el sexo de la persona, el día de la clínica y la entrevista de su
 * producto) llega de ella: no se vuelve a leer dentro de la misma transacción.
 */
export async function healthAtSigningOf(
  tx: Db,
  orgId: string,
  patientId: string,
  context: { sex: string | null; today: string; interview: Pick<ProductInterview, "record"> },
): Promise<HealthAtSigning[]> {
  const health = await getPatientHealth(tx, orgId, patientId)
  if (health.declared.length === 0) return []
  const { sex, today } = context
  const interview = health.latestAnamnesis ? context.interview.record(health.latestAnamnesis.answers, today) : []
  const last = health.declared.at(-1)
  return health.declared.flatMap((group) => {
    const rows = healthAtSigningRows(health, group, { sex, today, last: group === last, interview })
    return rows.length > 0 ? [{ by: group.by, at: group.at?.toISOString() ?? null, rows }] : []
  })
}
