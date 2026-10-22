// Subencargados del tratamiento: proveedores que tratan datos de las clínicas por cuenta de odentIA.
// La lista vive en `@odentia/auth/data-processors`, la misma que ve cada clínica en Protección de datos.
// Al añadir o cambiar uno, actualiza LEGAL_UPDATED y avisa a las clínicas con la antelación del encargo.
import { ALWAYS_PROCESSORS, type DataProcessor, OPTIONAL_PROCESSORS } from "@odentia/auth/data-processors"
import { contactEmail } from "../site"
import type { LegalDoc } from "./types"

/** Proveedor, para qué, datos que trata, país o región: de la lista compartida con la clínica. */
const row = (p: DataProcessor): string[] => [p.name, p.purpose, p.data, p.country]
const PLATAFORMA = ALWAYS_PROCESSORS.map(row)
const SEGUN_CLINICA = OPTIONAL_PROCESSORS.map(row)

const HEAD = ["Proveedor", "Para qué", "Datos que trata", "País o región"]

export const SUBENCARGADOS: LegalDoc = {
  path: "/subencargados",
  title: "Subencargados del tratamiento",
  description:
    "Proveedores que tratan datos por cuenta de odentIA: alojamiento, almacenamiento, correo, modelos de inteligencia artificial, transcripción, direcciones y canales de mensajería. Para qué, qué datos y en qué país.",
  intro: [
    "Para prestar el servicio, odentIA recurre a los proveedores de esta lista, que tratan datos de las clínicas y de sus pacientes por cuenta de odentIA. Esta página forma parte del [contrato de encargo de tratamiento](/encargo-de-tratamiento).",
  ],
  sections: [
    {
      id: "plataforma",
      title: "Proveedores de la plataforma",
      blocks: [
        "Intervienen siempre, para todas las clínicas.",
        { table: { caption: "Proveedores que intervienen siempre", head: HEAD, rows: PLATAFORMA } },
      ],
    },
    {
      id: "segun-clinica",
      title: "Proveedores que dependen de la clínica",
      blocks: [
        "Solo intervienen si la clínica conecta el canal, usa los agentes o dicta en la atención. Un canal que la clínica no conecta, o un modelo que no usa, no recibe ningún dato.",
        {
          table: {
            caption: "Proveedores que intervienen según la configuración de la clínica",
            head: HEAD,
            rows: SEGUN_CLINICA,
          },
        },
        "Las plantillas de mensajes de WhatsApp las cobra Meta directamente a la clínica. Cada proveedor de canales trata además los datos según sus propias condiciones, que la clínica acepta al conectar su cuenta.",
      ],
    },
    {
      id: "entrenamiento",
      title: "Uso de los datos para entrenar modelos",
      blocks: [
        "odentIA no usa los datos de las clínicas ni de sus pacientes para entrenar modelos propios. Los proveedores de inteligencia artificial tratan los datos que reciben según sus condiciones de uso de API [Por confirmar con el proveedor de IA y el abogado: si los proveedores usan o no los datos para entrenar].",
      ],
    },
    {
      id: "cambios",
      title: "Cambios en esta lista",
      blocks: [
        "odentIA avisará a las clínicas de cualquier alta o sustitución de un subencargado con la antelación prevista en el [contrato de encargo de tratamiento](/encargo-de-tratamiento), y cada clínica podrá oponerse en los términos allí indicados.",
        `Para preguntas sobre esta lista, escriba a [${contactEmail}](mailto:${contactEmail}).`,
      ],
    },
  ],
}
