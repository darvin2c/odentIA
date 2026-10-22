// Subencargados del tratamiento: proveedores que tratan datos de las clínicas por cuenta de odentIA.
// Al añadir o cambiar uno, actualiza LEGAL_UPDATED y avisa a las clínicas con la antelación del encargo.
import { contactEmail } from "../site"
import type { LegalDoc } from "./types"

/** Proveedor, para qué, datos que trata, país o región. */
const PLATAFORMA: string[][] = [
  [
    "Servidor VPS: [Por completar: proveedor]",
    "Alojar la aplicación y la base de datos.",
    "Todos los datos de la cuenta y de los pacientes.",
    "[Por completar: país]",
  ],
  [
    "Cloudflare, Inc. (Cloudflare R2)",
    "Almacenar archivos: adjuntos, imágenes, documentos y audios de dictado.",
    "Archivos que la clínica y sus pacientes suben o envían.",
    "Estados Unidos [Por confirmar: región de almacenamiento]",
  ],
  [
    "Correo transaccional por SMTP: [Por completar: proveedor]",
    "Enviar correos del sistema: invitaciones, avisos, facturas.",
    "Nombre y correo del destinatario y contenido del mensaje.",
    "[Por completar: país]",
  ],
  [
    "Jev",
    "Modelo de decisión de la plataforma: entender qué pide cada mensaje para dirigirlo.",
    "Texto de los mensajes recibidos.",
    "[Por completar: país]",
  ],
  [
    "OpenAI, L.L.C. (modelo de decisión)",
    "Modelo de decisión de la plataforma: entender qué pide cada mensaje para dirigirlo.",
    "Texto de los mensajes recibidos.",
    "Estados Unidos",
  ],
  [
    "OpenAI, L.L.C. (transcripción)",
    "Pasar a texto las notas de voz que llegan por los canales y los dictados de la consulta.",
    "Audios de las notas de voz y de los dictados, que pueden incluir datos de salud.",
    "Estados Unidos",
  ],
  [
    "Geoapify GmbH",
    "Sugerir la dirección mientras se escribe en los datos de un paciente o en su registro.",
    "Solo el texto de la dirección que se escribe, sin el nombre de la persona.",
    "Alemania",
  ],
  [
    "Google LLC (Google Maps Platform, Places)",
    "Sugerir y ubicar la dirección de las sedes de la clínica.",
    "Solo el texto de la dirección de la sede que se escribe.",
    "Estados Unidos",
  ],
  [
    "Embeddings: [Por completar: proveedor]",
    "Convertir el conocimiento de la clínica en vectores para buscar en él.",
    "Textos que la clínica carga como conocimiento y consultas de búsqueda.",
    "[Por completar: país]",
  ],
]

const SEGUN_CLINICA: string[][] = [
  [
    "OpenAI, L.L.C. («ChatGPT 6»)",
    "Modelo de inteligencia artificial de los agentes, si la clínica los usa.",
    "Conversaciones, dictados y datos de pacientes necesarios para la tarea, incluidos datos de salud.",
    "Estados Unidos",
  ],
  [
    "Meta Platforms, Inc. (WhatsApp Business, Instagram, Messenger)",
    "Enviar y recibir mensajes por esos canales, si la clínica los conecta.",
    "Nombre de perfil, número o identificador y contenido de los mensajes.",
    "Estados Unidos [Por confirmar: entidad de Meta que corresponde según el país de la clínica]",
  ],
  [
    "Telegram",
    "Enviar y recibir mensajes por Telegram, si la clínica lo conecta.",
    "Nombre de usuario, identificador y contenido de los mensajes.",
    "Emiratos Árabes Unidos [Por confirmar: entidad y país de Telegram]",
  ],
  [
    "Google LLC (Gmail)",
    "Enviar y recibir correos desde la cuenta de la clínica, si la conecta.",
    "Direcciones y contenido de los correos.",
    "Estados Unidos",
  ],
  [
    "Microsoft Corporation (Microsoft 365)",
    "Enviar y recibir correos desde la cuenta de la clínica, si la conecta.",
    "Direcciones y contenido de los correos.",
    "Estados Unidos",
  ],
]

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
        "Solo intervienen si la clínica conecta el canal o usa los agentes. Un canal que la clínica no conecta, o un modelo que sus agentes no usan, no recibe ningún dato.",
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
