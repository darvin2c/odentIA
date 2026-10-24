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
 * escribe en el texto (decisión 4 del issue 229); Clío dicta la consulta, los
 * signos vitales, el examen y el descanso (entrega 10). La
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
  // Lo que se puede dictar a Clío en un consultorio (entrega 10, decisión 20).
  dictation: {
    examples: [
      { block: "Consulta", say: "«Viene por fiebre y dolor de garganta hace tres días»" },
      { block: "Examen", say: "«Presión 118 con 76, temperatura 38 y medio, amígdalas con placas, pulmones limpios»" },
      { block: "Diagnóstico", say: "«Parece una amigdalitis»" },
      { block: "Receta", say: "«Amoxicilina de 500 cada 8 horas por 10 días»" },
      { block: "Control", say: "«Control en una semana si no mejora»" },
      { block: "Descanso", say: "«Descanso de tres días»" },
      { block: "Corregir", say: "«No, la temperatura es 38,4» · «Quita el ibuprofeno»" },
    ],
    placeholder: "Presión 118 con 76, temperatura 38 y medio, amígdalas con placas, pulmones limpios…",
    practice:
      "Viene por fiebre y dolor de garganta hace tres días. Presión 118 con 76, temperatura 38 y medio. Amígdalas con placas, pulmones limpios. Parece una amigdalitis. Control en una semana.",
  },
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
