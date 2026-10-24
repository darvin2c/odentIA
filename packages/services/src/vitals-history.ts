import { parseVitals, type Vitals } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import { and, desc, eq, isNotNull, ne } from "drizzle-orm"
import { requirePatient } from "./patients.js"

/** Los signos vitales de una atención, con cuándo y quién los tomó. */
export interface VitalsReading {
  encounterId: string
  startedAt: Date
  /** borrador o finalizada: la de hoy también cuenta («en la atención de hoy»). */
  status: string
  professionalUserId: string
  vitals: Vitals
}

/** Las últimas atenciones que se muestran: años de controles mensuales, de sobra. */
const READINGS_LIMIT = 500

/**
 * Los signos vitales de la persona en el tiempo, de la más antigua a la más
 * reciente: la sección «Signos vitales» de la ficha (issue 229, decisión 6).
 * Las anuladas no cuentan; lo guardado que ya no se entiende se omite.
 */
export async function listPatientVitals(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<VitalsReading[]> {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx
    .select({
      encounterId: encounter.id,
      startedAt: encounter.startedAt,
      status: encounter.status,
      professionalUserId: encounter.professionalUserId,
      vitals: encounter.vitals,
    })
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        ne(encounter.status, "anulada"),
        isNotNull(encounter.vitals),
      ),
    )
    .orderBy(desc(encounter.startedAt), desc(encounter.id))
    .limit(READINGS_LIMIT)
  return rows.reverse().flatMap((row) => {
    const parsed = parseVitals(row.vitals)
    if (!parsed.ok || !parsed.value) return []
    return [{ ...row, vitals: parsed.value }]
  })
}
