/**
 * El panel de la pieza en un solo formulario (fase 3, tablero 4): el hallazgo,
 * su diagnóstico (de la lista de la clínica) con el tipo —que es el diagnóstico de la atención: no
 * se escribe dos veces— y el tratamiento, que se agrega al plan abierto de la
 * persona (o lo abre: ADR 0034). Todo en la transacción de quien llama: o
 * queda todo o no queda nada. Compone las operaciones de siempre
 * (`addOdontogramEntries`, `addEncounterDiagnosis`, `addPlanItem`): aquí no
 * hay otra regla de hallazgos, diagnósticos ni planes.
 */
import { isDiagnosisSystem, normalizeDiagnosisCode } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { type FindingDetails, findingDefinition, isValidTooth } from "@odentia/dental"
import { findDiagnosisCode, findingDiagnosisCode, orgDiagnosisSystem } from "../diagnosis-codes.js"
import { addEncounterDiagnosis } from "../encounter-diagnoses.js"
import { invalidField } from "../errors.js"
import { addPlanItem } from "../plan.js"
import { requireServiceForIndication } from "../service-catalog.js"
import { addOdontogramEntries } from "./odontogram.js"

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
  treatment?: { serviceId: string; detail?: string | null; plannedSessions?: number } | null
}

/**
 * El código que guarda el hallazgo: el suyo, nunca el de otro diagnóstico
 * elegido junto (segundo repaso del 9 nov, N8: la caries CDP de la 46 quedaba
 * rotulada «Lesión de caries dental · DA09.0», el código de la pulpitis). Si
 * lo elegido es de la misma categoría que el que propone el hallazgo (otra
 * caries: K02.1 en vez de K02.5), vale lo elegido; si es de otra (la pulpitis,
 * K04/DA09), el hallazgo lleva el suyo (`findingDiagnosisCode`, por su
 * profundidad) si está en la lista de la clínica, o ninguno. Un hallazgo que
 * no propone código (una restauración) lleva lo elegido, como siempre. Lo
 * elegido sigue siendo el diagnóstico de la atención y el del tratamiento.
 */
async function findingCodeOf(
  tx: Db,
  orgId: string,
  input: Pick<RegisterToothFindingInput, "condition" | "details" | "diagnosis">,
): Promise<{ diagnosisCode: string | null; diagnosisSystem: string | null }> {
  const chosen = input.diagnosis
  const code = chosen?.diagnosisCode?.trim()
  if (!chosen || !code) return { diagnosisCode: null, diagnosisSystem: null }
  const asChosen = {
    diagnosisCode: chosen.diagnosisCode,
    diagnosisSystem: chosen.diagnosisSystem ?? null,
  }
  const system = chosen.diagnosisSystem?.trim() || (await orgDiagnosisSystem(tx, orgId))
  // Una lista que no existe la rechaza el registro del hallazgo, con su mensaje.
  if (!isDiagnosisSystem(system)) return asChosen
  const variant = input.details?.variant
  const own = findingDiagnosisCode(
    system,
    input.condition,
    typeof variant === "string" ? variant : null,
  )
  if (!own) return asChosen
  const category = (value: string) => normalizeDiagnosisCode(system, value).split(".")[0]
  if (category(own) === category(code)) return asChosen
  const found = await findDiagnosisCode(tx, system, own)
  return found
    ? { diagnosisCode: found.code, diagnosisSystem: system }
    : { diagnosisCode: null, diagnosisSystem: null }
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
    throw invalidField("toothNumbers", "Elige la pieza o las piezas del hallazgo")
  const def = findingDefinition(input.condition)
  if (!def) throw invalidField("condition", "Elige el hallazgo de la lista")
  const group = def.scope === "pair" || def.scope === "span" || def.scope === "arch"
  const surfaces = teeth.length === 1 ? (input.surfaces ?? []) : []
  if ((input.surfaces ?? []).length > 0 && teeth.length > 1)
    throw invalidField("surfaces", "Las caras se registran con una sola pieza")
  // Lo que se planifica aquí es de la pieza: lo demás se indica en «Plan y controles».
  const service = input.treatment?.serviceId
    ? await requireServiceForIndication(tx, orgId, input.treatment.serviceId)
    : null
  if (service && service.scope !== "tooth" && service.scope !== "surfaces")
    throw invalidField(
      "treatment.serviceId",
      `«${service.name}» no es un tratamiento de una pieza: indícalo en «Plan y controles» de la atención`,
    )
  const targets = group ? [teeth[0]!] : teeth
  const findingCode = await findingCodeOf(tx, orgId, input)
  const entries = []
  const diagnoses = []
  const planItems = []
  for (const toothNumber of targets) {
    const rows = await addOdontogramEntries(
      tx,
      orgId,
      actorUserId,
      patientId,
      {
        encounterId: input.encounterId,
        toothNumber,
        condition: input.condition,
        surfaces,
        details: group ? { ...(input.details ?? {}), relatedTeeth: teeth } : input.details,
        note: input.note ?? null,
        // El del hallazgo, no el del diagnóstico elegido junto (`findingCodeOf`).
        ...findingCode,
      },
      { diagnosisField: "diagnosis.diagnosisCode" },
    )
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
          // Las que se dijeron en el panel; sin ellas, las habituales del servicio (`addPlanItem`).
          ...(input.treatment?.plannedSessions !== undefined ? { plannedSessions: input.treatment.plannedSessions } : {}),
        }),
      )
    }
  }
  return { entries, diagnoses, planItems }
}
