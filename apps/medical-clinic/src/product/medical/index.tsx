import { bareProduct, type ProductUi } from "@odentia/clinic-app/product/product-ui"
import { MEDICAL_CATEGORY_LABELS, MEDICAL_IMAGING_TYPES, MEDICAL_SERVICE_KINDS } from "@odentia/medical"
import { medicalExamination } from "./examination"
import { medicalHealth } from "./health"
import { medicalPrescribing } from "./prescribing"
import { ProblemsCard } from "./problems-card"
import { VitalsSection } from "./vitals-section"

const bare = bareProduct("medical")

/**
 * Lo que latidIA aporta a las pantallas comunes (ADR 0079). El «dónde» se
 * escribe en el texto (decisión 4 del issue 229) y Clío aún no dicta. La
 * ficha tiene «Signos vitales» en el lugar del Odontograma, los antecedentes
 * médicos y la lista de problemas; la atención, el examen físico por sistemas
 * (entrega 5); la receta, la lista de medicina general y sus reglas (entrega
 * 6); el catálogo, su biblioteca y las cinco especialidades (entrega 8).
 */
export const medicalUi: ProductUi = {
  ...bare,
  record: {
    sections: [
      {
        id: "signos-vitales",
        label: "Signos vitales",
        needsRecord: true,
        render: ({ patientId, record }) => <VitalsSection patientId={patientId} record={record} />,
      },
    ],
  },
  // Las cinco especialidades son las mismas en todo país: no salen de una norma.
  country: { ...bare.country, specialtiesNorm: () => "Lista general de latidIA" },
  // Los tipos de su biblioteca, para filtrarla; nada queda dibujado al completar un servicio.
  services: { kinds: MEDICAL_SERVICE_KINDS.map((kind) => ({ key: kind.key, name: kind.name })), leaves: null },
  // Lo indicado queda aceptado al indicarlo: el presupuesto es opcional (decisión
  // 15); los controles pueden repetirse (decisión 16).
  plan: { ...bare.plan, budgetRequired: false, repeatingControls: true },
  encounter: { ...bare.encounter, examination: medicalExamination },
  health: medicalHealth,
  summary: { ClinicalCards: (props) => <ProblemsCard {...props} /> },
  prescribing: medicalPrescribing,
  documents: {
    ...bare.documents,
    imaging: { types: MEDICAL_IMAGING_TYPES, categoryLabels: MEDICAL_CATEGORY_LABELS },
    // El descanso médico, junto a la receta (decisión 8).
    medicalLeave: true,
  },
}
