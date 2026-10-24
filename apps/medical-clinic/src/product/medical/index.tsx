import { bareProduct, type ProductUi } from "@odentia/clinic-app/product/product-ui"
import { medicalExamination } from "./examination"
import { medicalHealth } from "./health"
import { ProblemsCard } from "./problems-card"
import { VitalsSection } from "./vitals-section"

const bare = bareProduct("medical")

/**
 * Lo que latidIA aporta a las pantallas comunes (ADR 0079). El «dónde» se
 * escribe en el texto (decisión 4 del issue 229) y Clío aún no dicta. La
 * ficha tiene «Signos vitales» en el lugar del Odontograma, los antecedentes
 * médicos y la lista de problemas; la atención, el examen físico por sistemas
 * (entrega 5). La receta y el catálogo llegan en las entregas 6 a 8 del plan.
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
  encounter: { ...bare.encounter, examination: medicalExamination },
  health: medicalHealth,
  summary: { ClinicalCards: (props) => <ProblemsCard {...props} /> },
}
