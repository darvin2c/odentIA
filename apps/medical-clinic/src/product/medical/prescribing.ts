import { weightForAgeAlert } from "@odentia/clinical"
import { apiFetch } from "@odentia/clinic-app/lib/api"
import {
  fetchPatientHealth,
  fetchPatientVitals,
  type PatientFull,
} from "@odentia/clinic-app/lib/patients"
import type {
  PrescribingRulesUi,
  ProductPrescribingUi,
} from "@odentia/clinic-app/product/product-ui"
import {
  ageInYears,
  checkPrescription,
  MEDICAL_MEDICATION_CATALOG,
  readMedicalHistory,
  WEIGHT_REQUIRED_UNDER_YEARS,
} from "@odentia/medical"
import { regionToday } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"

/**
 * Las reglas de la receta para esta persona (issue 229, decisión 12), las
 * mismas que revisa el servidor al emitir: con sus antecedentes, su edad y el
 * último peso registrado, que se propone a un menor de 12 años.
 */
function useMedicalPrescribingRules(patientId: string, enabled: boolean): PrescribingRulesUi {
  const health = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled,
  })
  const person = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled,
  })
  const vitals = useQuery({
    queryKey: ["patient-vitals", patientId],
    queryFn: () => fetchPatientVitals(patientId),
    enabled,
  })
  const today = regionToday()
  const birthDate = person.data?.data.patient.birthDate ?? null
  const context = {
    history: readMedicalHistory(health.data?.data.latestAnamnesis?.answers, today),
    birthDate,
    today,
    medications: MEDICAL_MEDICATION_CATALOG.medications,
  }
  const age = ageInYears(birthDate, today)
  const lastWeight =
    vitals.data?.data.filter((reading) => reading.vitals.peso !== undefined).at(-1)?.vitals.peso ??
    null
  return {
    // El embarazo, la lactancia y lo demás que avisa toda receta lo suma la receta misma (`prescribingAlerts`).
    check: (items, weightKg) => ({ errors: checkPrescription(context, items, weightKg).errors }),
    // El último peso no se propone si es imposible para su edad («230 kg» a los 7 años): se revisa antes.
    weight: {
      required: age !== null && age < WEIGHT_REQUIRED_UNDER_YEARS,
      suggested: lastWeight !== null && weightForAgeAlert(lastWeight, age) ? null : lastWeight,
      ageYears: age,
    },
  }
}

/** La receta de latidIA: la lista de medicina general y sus reglas. */
export const medicalPrescribing: ProductPrescribingUi = {
  catalog: MEDICAL_MEDICATION_CATALOG,
  useRules: useMedicalPrescribingRules,
}
