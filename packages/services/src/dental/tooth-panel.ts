/**
 * El panel de la pieza en un solo formulario (fase 3, tablero 4): el hallazgo,
 * su diagnóstico (de la lista de la clínica) con el tipo —que es el diagnóstico de la atención: no
 * se escribe dos veces— y el tratamiento, que se agrega al plan abierto de la
 * persona (o lo abre: ADR 0034). Todo en la transacción de quien llama: o
 * queda todo o no queda nada. Compone las operaciones de siempre
 * (`addOdontogramEntries`, `addEncounterDiagnosis`, `addPlanItem`): aquí no
 * hay otra regla de hallazgos, diagnósticos ni planes.
 */
import { findingDefinition, type FindingDetails, isValidTooth } from "@odentia/dental"
import type { Db } from "@odentia/db"
import { addOdontogramEntries } from "./odontogram.js"
import { addEncounterDiagnosis } from "../encounter-diagnoses.js"
import { validation } from "../errors.js"
import { addPlanItem } from "../plan.js"
import { requireServiceForIndication } from "../service-catalog.js"

export interface RegisterToothFindingInput {
  /** Atención en borrador de quien registra. */
  encounterId: string
  /**
   * La pieza o las piezas elegidas. Un hallazgo de pareja, tramo o arcada se
   * registra una vez con todas; los demás, uno por pieza.
   */
  toothNumbers: number[]
  condition: string
  /** Caras comprometidas: solo con una pieza. */
  surfaces?: string[]
  details?: FindingDetails
  note?: string | null
  /** Diagnóstico con su tipo: cuenta como diagnóstico de la atención. */
  diagnosis?: { diagnosisCode: string; diagnosisSystem?: string | null; diagnosisType: string } | null
  /** Tratamiento por pieza o por superficies que se agrega al plan abierto. */
  treatment?: { serviceId: string; detail?: string | null } | null
}

/**
 * «Registrar y agregar al plan»: deja el hallazgo, su diagnóstico y su
 * tratamiento en una sola operación. El tratamiento nace del hallazgo (queda
 * tratado al cerrar la atención en que se realice) y lleva su diagnóstico.
 */
export async function registerToothFinding(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: RegisterToothFindingInput,
) {
  const teeth = [...new Set(input.toothNumbers ?? [])]
  if (teeth.length === 0 || teeth.length > 52 || teeth.some((tooth) => !isValidTooth(tooth)))
    throw validation("Elige la pieza o las piezas del hallazgo")
  const def = findingDefinition(input.condition)
  if (!def) throw validation("Elige el hallazgo de la lista")
  const group = def.scope === "pair" || def.scope === "span" || def.scope === "arch"
  const surfaces = teeth.length === 1 ? (input.surfaces ?? []) : []
  if ((input.surfaces ?? []).length > 0 && teeth.length > 1)
    throw validation("Las caras se registran con una sola pieza")
  // Lo que se planifica aquí es de la pieza: lo demás se indica en «Plan y controles».
  const service = input.treatment?.serviceId
    ? await requireServiceForIndication(tx, orgId, input.treatment.serviceId)
    : null
  if (service && service.scope !== "tooth" && service.scope !== "surfaces")
    throw validation(
      `«${service.name}» no es un tratamiento de una pieza: indícalo en «Plan y controles» de la atención`,
    )
  const targets = group ? [teeth[0]!] : teeth
  const entries = []
  const diagnoses = []
  const planItems = []
  for (const toothNumber of targets) {
    const rows = await addOdontogramEntries(tx, orgId, actorUserId, patientId, {
      encounterId: input.encounterId,
      toothNumber,
      condition: input.condition,
      surfaces,
      details: group ? { ...(input.details ?? {}), relatedTeeth: teeth } : input.details,
      note: input.note ?? null,
      diagnosisCode: input.diagnosis?.diagnosisCode ?? null,
      diagnosisSystem: input.diagnosis?.diagnosisSystem ?? null,
    })
    entries.push(...rows)
    if (input.diagnosis) {
      diagnoses.push(
        await addEncounterDiagnosis(tx, orgId, actorUserId, patientId, input.encounterId, {
          diagnosisCode: input.diagnosis.diagnosisCode,
          diagnosisSystem: input.diagnosis.diagnosisSystem ?? null,
          diagnosisType: input.diagnosis.diagnosisType,
          toothNumber,
          surfaces,
        }),
      )
    }
    if (service) {
      planItems.push(
        await addPlanItem(tx, orgId, actorUserId, patientId, {
          serviceId: service.id,
          sourceEncounterId: input.encounterId,
          toothNumber,
          surfaces: service.scope === "surfaces" ? surfaces : null,
          odontogramEntryId: rows[0]?.id ?? null,
          diagnosisCode: input.diagnosis?.diagnosisCode ?? null,
          diagnosisSystem: input.diagnosis?.diagnosisSystem ?? null,
          detail: input.treatment?.detail ?? null,
        }),
      )
    }
  }
  return { entries, diagnoses, planItems }
}
