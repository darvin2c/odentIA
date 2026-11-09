import { isDiagnosisSystem } from "@odentia/clinical"
import {
  OPTICAL_CONSENT_TEMPLATES,
  OPTICAL_IMAGING_TYPES,
  OPTICAL_MEDICATION_CATALOG,
  OPTICAL_PLAN_PHASE,
  opticalDiagnosisPattern,
} from "@odentia/optical"
import { NO_PRODUCT_HOOKS, type ProductHooks } from "../product-hooks.js"
import { opticalCatalog } from "./catalog.js"

/**
 * Lo que vistIA hace en los momentos de lo común (ADR 0079). Sin «dónde» (el ojo
 * se dice en la atención) y sin dictado: la mesa del plan quitó dictar la
 * refracción, porque un signo o un eje mal oídos son lentes mal hechos. Lo
 * indicado queda aceptado al indicarlo, como en latidIA: una óptica cotiza con
 * el pedido, no con el presupuesto clínico. Se invita a volver al año, al
 * control anual de la vista. Su biblioteca y sus especialidades son las de una
 * óptica, su plan tiene una sola fase y el buscador de diagnósticos pone primero
 * los del ojo. No anestesia: no pregunta la ASA.
 */
export const opticalHooks: ProductHooks = {
  ...NO_PRODUCT_HOOKS,
  budgetRequired: false,
  asksAsa: false,
  recallMonths: 12,
  recallControlTitle: "Control anual de la vista",
  catalog: opticalCatalog,
  planPhases: [OPTICAL_PLAN_PHASE],
  phaseFor: () => OPTICAL_PLAN_PHASE,
  preferredDiagnoses: (system) => (isDiagnosisSystem(system) ? opticalDiagnosisPattern(system) : null),
  imaging: OPTICAL_IMAGING_TYPES,
  // La tomografía de una óptica es la OCT: una imagen con su informe, no un estudio en cortes.
  imagingStudy: null,
  consentSuggestions: OPTICAL_CONSENT_TEMPLATES,
  // Su lista propia, no la dental: lubricantes y lo del ojo irritado o alérgico.
  prescribing: { catalog: OPTICAL_MEDICATION_CATALOG, review: async () => ({ errors: [], warnings: [] }) },
}
