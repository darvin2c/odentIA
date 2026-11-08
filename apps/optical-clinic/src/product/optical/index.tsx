import { bareProduct, type ProductUi } from "@odentia/clinic-app/product/product-ui"
import {
  OPTICAL_CATEGORY_LABELS,
  OPTICAL_IMAGING_TYPES,
  OPTICAL_SERVICE_KINDS,
  opticalProfessionalFor,
} from "@odentia/optical"

const bare = bareProduct("optical")

/**
 * Lo que vistIA aporta a las pantallas comunes (ADR 0079). El ojo se escribe en
 * el texto (sin «dónde» aparte) y Clío no dicta: la mesa del plan quitó dictar la
 * refracción. Lo indicado queda aceptado al indicarlo (una óptica cotiza con el
 * pedido, no con el presupuesto clínico) y los controles pueden repetirse, como
 * el control anual de la vista. Una óptica no anestesia: la ASA no se pide. Sus
 * imágenes son las pruebas del ojo; la OCT es una imagen con su informe, no un
 * estudio en cortes. El examen de la vista y la receta de lentes llegan en la
 * siguiente entrega.
 */
export const opticalUi: ProductUi = {
  ...bare,
  // Las tres especialidades son las mismas en todo país. En Perú, el perfil profesional
  // propone «Tecnólogo médico en optometría» y el CTMP.
  country: {
    ...bare.country,
    specialtiesNorm: () => "Lista general de vistIA",
    professional: opticalProfessionalFor,
  },
  // Los tipos de su biblioteca, para filtrarla; nada queda dibujado al completar un servicio.
  services: { kinds: OPTICAL_SERVICE_KINDS.map((kind) => ({ key: kind.key, name: kind.name })), leaves: null },
  plan: { ...bare.plan, budgetRequired: false, repeatingControls: true },
  health: { ...bare.health, showsAsa: false },
  documents: {
    ...bare.documents,
    imaging: {
      types: OPTICAL_IMAGING_TYPES,
      categoryLabels: OPTICAL_CATEGORY_LABELS,
      // Sin visor de cortes: ninguna prueba de una óptica es una tomografía en cortes.
      tomography: null,
    },
  },
}
