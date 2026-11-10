import { OPTICAL_KIND_WORDS, OPTICAL_SERVICE_KINDS, OPTICAL_SPECIALTIES } from "@odentia/optical"
import type { ProductCatalog } from "../product-catalog.js"

/**
 * El catálogo de vistIA: los tipos de su biblioteca y las tres especialidades con
 * que nace toda óptica, en cualquier país.
 */
export const opticalCatalog: ProductCatalog = {
  kinds: OPTICAL_SERVICE_KINDS,
  kindWords: OPTICAL_KIND_WORDS,
  // Cómo piden los clientes una atención de la vista y cómo se llama en el catálogo.
  everydayWords: {
    medida: ["examen", "vista"],
    medirme: ["examen", "vista"],
    graduacion: ["examen", "vista"],
    pupilentes: ["lentes de contacto"],
    lentillas: ["lentes de contacto"],
    lunas: ["anteojos"],
    armazon: ["anteojos"],
    montura: ["anteojos"],
    presion: ["tonometria"],
  },
  specialties: () => OPTICAL_SPECIALTIES,
  // Los exámenes y controles de `biblioteca_optica.csv`; las pruebas, el taller y la terapia no.
  consultations: [
    "examen-de-la-vista",
    "control-de-la-vista",
    "examen-de-la-vista-ninos",
    "evaluacion-baja-vision",
    "control-lentes-de-contacto",
  ],
}
