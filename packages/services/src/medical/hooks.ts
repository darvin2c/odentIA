import { medicalHistoryLines, MEDICAL_VITAL_KEYS, readMedicalHistory } from "@odentia/medical"
import { patientAnamnesis } from "@odentia/db/schema/clinical"
import { and, desc, eq } from "drizzle-orm"
import { clinicToday } from "../inventory-stock.js"
import { NO_PRODUCT_HOOKS, type ProductHooks } from "../product-hooks.js"
import { medicalExamination } from "./examination.js"
import { medicalInterview } from "./interview.js"
import { medicalPrescribing } from "./prescribing.js"

/**
 * Lo que latidIA hace en los momentos de lo común (ADR 0079). Sin «dónde»
 * (la parte del cuerpo se escribe, decisión 4 del issue 229) ni dictado
 * todavía; su examen es por sistemas, registra dos signos vitales más y su
 * entrevista suma los antecedentes médicos, que la copia de la historia lleva.
 */
export const medicalHooks: ProductHooks = {
  ...NO_PRODUCT_HOOKS,
  prescribing: medicalPrescribing,
  interview: medicalInterview,
  examination: medicalExamination,
  vitals: MEDICAL_VITAL_KEYS,
  async recordSections(tx, { orgId, patientId }) {
    const [latest] = await tx
      .select({ answers: patientAnamnesis.answers })
      .from(patientAnamnesis)
      .where(and(eq(patientAnamnesis.organizationId, orgId), eq(patientAnamnesis.patientId, patientId)))
      .orderBy(desc(patientAnamnesis.version))
      .limit(1)
    const today = await clinicToday(tx, orgId)
    return [
      {
        title: "Antecedentes médicos",
        lines: medicalHistoryLines(readMedicalHistory(latest?.answers, today), today),
        empty: "Sin embarazo, hábitos ni vacunas registrados.",
      },
    ]
  },
}
