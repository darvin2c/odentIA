import { isDiagnosisSystem } from "@odentia/clinical"
import {
  MEDICAL_CONSENT_TEMPLATES,
  MEDICAL_IMAGING_TYPES,
  MEDICAL_PLAN_PHASE,
  MEDICAL_VITAL_KEYS,
  medicalDiagnosisPattern,
  medicalHistoryLines,
  readMedicalHistory,
} from "@odentia/medical"
import { patientAnamnesis } from "@odentia/db/schema/clinical"
import { and, desc, eq } from "drizzle-orm"
import { clinicToday } from "../inventory-stock.js"
import { NO_PRODUCT_HOOKS, type ProductHooks } from "../product-hooks.js"
import { medicalCatalog } from "./catalog.js"
import { MEDICAL_DICTATION } from "./dictation.js"
import { medicalExamination } from "./examination.js"
import { medicalInterview } from "./interview.js"
import { medicalPrescribing } from "./prescribing.js"

/**
 * Lo que latidIA hace en los momentos de lo común (ADR 0079). Sin «dónde»
 * (la parte del cuerpo se escribe, decisión 4 del issue 229); Clío dicta sus
 * signos vitales, su examen y el descanso (entrega 10); su examen es por sistemas, registra dos signos vitales más y su
 * entrevista suma los antecedentes médicos, que la copia de la historia lleva.
 * Lo indicado queda aceptado al indicarlo: el presupuesto es opcional; y se
 * invita a volver a quien no viene hace un año (decisiones 15 y 16). Su
 * biblioteca y sus especialidades son las del consultorio (entrega 8), su plan
 * tiene una sola fase y el buscador de diagnósticos pone primero los
 * capítulos de la atención primaria.
 */
export const medicalHooks: ProductHooks = {
  ...NO_PRODUCT_HOOKS,
  budgetRequired: false,
  recallMonths: 12,
  catalog: medicalCatalog,
  planPhases: [MEDICAL_PLAN_PHASE],
  phaseFor: () => MEDICAL_PLAN_PHASE,
  preferredDiagnoses: (system) => (isDiagnosisSystem(system) ? medicalDiagnosisPattern(system) : null),
  prescribing: medicalPrescribing,
  imaging: MEDICAL_IMAGING_TYPES,
  consentSuggestions: MEDICAL_CONSENT_TEMPLATES,
  interview: medicalInterview,
  examination: medicalExamination,
  vitals: MEDICAL_VITAL_KEYS,
  dictation: MEDICAL_DICTATION,
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
