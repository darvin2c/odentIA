import type { Db } from "@odentia/db"
import { patientAnamnesis } from "@odentia/db/schema/clinical"
import { checkPrescription, MEDICAL_MEDICATION_CATALOG, readMedicalHistory } from "@odentia/medical"
import { and, desc, eq } from "drizzle-orm"
import { clinicToday } from "../inventory-stock.js"
import { requirePatient } from "../patients.js"
import type { ProductPrescribing } from "../product-hooks.js"

/** Los antecedentes médicos guardados de la persona: la última versión de su entrevista. */
async function latestAnswers(tx: Db, orgId: string, patientId: string): Promise<unknown> {
  const [latest] = await tx
    .select({ answers: patientAnamnesis.answers })
    .from(patientAnamnesis)
    .where(
      and(eq(patientAnamnesis.organizationId, orgId), eq(patientAnamnesis.patientId, patientId)),
    )
    .orderBy(desc(patientAnamnesis.version))
    .limit(1)
  return latest?.answers
}

/**
 * La receta de latidIA (issue 229, decisión 12): la lista de medicina general
 * y, al emitir, los controlados, el embarazo y el peso de un niño, con las
 * mismas reglas que la pantalla (`checkPrescription`).
 */
export const medicalPrescribing: ProductPrescribing = {
  catalog: MEDICAL_MEDICATION_CATALOG,
  async review(tx, { orgId, patientId, items, weightKg }) {
    const person = await requirePatient(tx, orgId, patientId)
    const today = await clinicToday(tx, orgId)
    const check = checkPrescription(
      {
        history: readMedicalHistory(await latestAnswers(tx, orgId, patientId), today),
        birthDate: person.birthDate ? String(person.birthDate).slice(0, 10) : null,
        today,
        medications: MEDICAL_MEDICATION_CATALOG.medications,
      },
      items,
      weightKg,
    )
    return { errors: check.errors, warnings: check.warnings }
  },
}
