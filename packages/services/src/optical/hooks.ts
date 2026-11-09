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
import { seedDemoJobOrders } from "./demo-orders.js"
import { opticalExamination } from "./examination.js"
import { renderLensPrescriptionPdf } from "./lens-prescription-pdf.js"
import {
  lensPrescriptionCheck,
  lensPrescriptionSnapshot,
  portalLensPrescriptions,
  prescriptionRecordLines,
  saleLensPrescriptions,
  seedDemoLensPrescriptions,
} from "./lens-prescriptions.js"

/**
 * Lo que vistIA hace en los momentos de lo común (ADR 0079). Sin «dónde» (el ojo
 * se dice en la atención) y sin dictado: la mesa del plan quitó dictar la
 * refracción, porque un signo o un eje mal oídos son lentes mal hechos. Lo
 * indicado queda aceptado al indicarlo, como en latidIA: una óptica cotiza con
 * el pedido, no con el presupuesto clínico. Se invita a volver al año, al
 * control anual de la vista. Su biblioteca y sus especialidades son las de una
 * óptica, su plan tiene una sola fase y el buscador de diagnósticos pone primero
 * los del ojo. No anestesia: no pregunta la ASA. Su examen es el de la vista
 * (entrega 3), sin signos vitales, y la copia de la historia lleva sus recetas de
 * lentes.
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
  examination: opticalExamination,
  vitals: [],
  // Una demo trae la receta de anteojos de cada examen firmado y, la primera vez,
  // sus pedidos de lentes en cada paso; cada noche los pedidos avanzan.
  async demoBuilt(tx, orgId, now) {
    await seedDemoLensPrescriptions(tx, orgId)
    await seedDemoJobOrders(tx, orgId, now)
  },
  // El cliente ve sus recetas de lentes en su portal y las descarga (entrega 3).
  portalPapers: { list: portalLensPrescriptions, pdf: renderLensPrescriptionPdf },
  // La venta de lentes copia en el pedido la receta vigente (entrega 4, ADR 0170).
  saleReference: { current: saleLensPrescriptions, snapshot: lensPrescriptionSnapshot },
  // El QR de la receta de lentes dice si está vigente, vencida o anulada.
  documentCheck: (tx, orgId, type, id) => (type === "lens_prescription" ? lensPrescriptionCheck(tx, orgId, id) : Promise.resolve(null)),
  async recordSections(tx, { orgId, patientId }) {
    return [
      {
        title: "Recetas de lentes",
        lines: await prescriptionRecordLines(tx, orgId, patientId),
        empty: "Sin recetas de lentes.",
      },
    ]
  },
  // Su lista propia, no la dental: lubricantes y lo del ojo irritado o alérgico.
  prescribing: { catalog: OPTICAL_MEDICATION_CATALOG, review: async () => ({ errors: [], warnings: [] }) },
}
