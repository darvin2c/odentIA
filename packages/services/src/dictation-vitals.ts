import { formatVitals, parseVitals, VITAL_SIGNS, type VitalSignKey, type Vitals, weightForAgeAlert } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import { updateEncounterDraft } from "./encounters.js"
import type { DictationPrepared } from "./product-hooks.js"

/*
 * ---------- Los signos vitales dictados, iguales en todo producto que los dicta ----------
 *
 * latidIA dicta todos los de su atención (issue 229); odentIA, el peso y la presión (mesa del 25
 * nov, entrega 3): lo medido llega a la anestesia con un clic. Un peso que alguien calcula o recuerda
 * («debe pesar 24») no es una medida y no llega aquí: va a «No lo usé».
 */

export const isVital = (key: string): key is VitalSignKey => VITAL_SIGNS.some((sign) => sign.key === key)

/**
 * Las medidas dictadas, juntas como las valida la atención (la presión va completa), solo las que
 * registra el producto (`keys`). Un peso imposible para su edad («230 kg» a los 7 años) queda por
 * revisar con su aviso: no entra de un toque ni da una dosis.
 */
export function prepareDictatedVitals(payload: Record<string, unknown>, keys: readonly VitalSignKey[], ageYears: number | null | undefined): DictationPrepared {
  const values = Object.fromEntries(Object.entries(payload).filter(([key]) => isVital(key) && keys.includes(key)))
  const parsed = parseVitals(values, keys)
  if (!parsed.ok) return { payload: values, status: "por_revisar", note: `${parsed.error}. Corrígelo o dilo de nuevo.` }
  if (!parsed.value) return { payload: values, status: "por_revisar", note: "No entendí ninguna medida. Dila de nuevo o escríbela." }
  const impossible = weightForAgeAlert(parsed.value.peso, ageYears)
  if (impossible) return { payload: parsed.value, status: "por_revisar", note: `${impossible} Corrígelo o dilo de nuevo.` }
  return { payload: parsed.value, status: "lista", note: null }
}

/** Lo que entraría a la atención, en pocas palabras: «PA 118/76 mmHg · Peso 23 kg». */
export const dictatedVitalsWords = (payload: Record<string, unknown>) => formatVitals(payload as Vitals)

/** Qué decía una medida antes de una corrección por voz; null si el campo no es un signo. */
export function vitalFieldWords(key: string, before: Record<string, unknown>): string | null {
  if (key === "presionSistolica" || key === "presionDiastolica")
    return typeof before["presionSistolica"] === "number" && typeof before["presionDiastolica"] === "number"
      ? formatVitals({ presionSistolica: before["presionSistolica"], presionDiastolica: before["presionDiastolica"] })
      : "sin presión"
  if (!isVital(key)) return null
  const old = before[key]
  const sign = VITAL_SIGNS.find((item) => item.key === key)
  return typeof old === "number" ? formatVitals({ [key]: old }) || `${sign?.label ?? key} ${old}` : `sin ${(sign?.label ?? key).toLowerCase()}`
}

/** Confirma lo dictado: se suma a lo que ya tenía la atención; una medida nueva reemplaza solo la suya. */
export async function confirmDictatedVitals(
  tx: Db,
  moment: { orgId: string; actorUserId: string; patientId: string; encounterId: string },
  payload: Record<string, unknown>,
): Promise<null> {
  const [current] = await tx
    .select({ vitals: encounter.vitals })
    .from(encounter)
    .where(and(eq(encounter.organizationId, moment.orgId), eq(encounter.patientId, moment.patientId), eq(encounter.id, moment.encounterId)))
    .limit(1)
  const vitals = { ...((current?.vitals as Record<string, unknown> | null) ?? {}), ...payload }
  await updateEncounterDraft(tx, moment.orgId, moment.actorUserId, moment.patientId, moment.encounterId, { vitals })
  return null
}
