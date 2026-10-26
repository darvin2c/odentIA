/**
 * Quién más trata los datos de las clínicas: los proveedores que odentIA usa
 * por cuenta de cada clínica (subencargados). Única fuente para la página
 * pública de subencargados de la web y para Configuración › Protección de
 * datos de cada clínica (ADR 0080). Al añadir o cambiar uno, actualiza la
 * fecha de los documentos legales y avisa a las clínicas con la antelación del
 * contrato de encargo.
 */

/**
 * Cuándo interviene: siempre, si la clínica usa los agentes, si usa el
 * dictado en la atención o si conecta uno de esos canales (`provider` de su
 * conexión).
 */
export type DataProcessorUse =
  | { kind: "siempre" }
  | { kind: "agentes" }
  | { kind: "dictado" }
  | { kind: "canal"; providers: readonly string[] }

export interface DataProcessor {
  id: string
  /** Nombre completo, como en el contrato: «Cloudflare, Inc. (Cloudflare R2)». */
  name: string
  /** Cómo se dice en una fila: «Cloudflare». */
  short: string
  purpose: string
  data: string
  /** Lo que recibe, dicho corto para la pantalla de la clínica. */
  receives: string
  country: string
  use: DataProcessorUse
}

/**
 * Dónde está el servidor y quién envía los correos. El país es el del centro
 * de datos que eligió odentIA, no el de la empresa: se confirma en su panel.
 */
const SERVER_PROVIDER = "OVHcloud"
const SERVER_COUNTRY = "Canadá"
const MAIL_PROVIDER = "Zoho CPaaS (antes ZeptoMail)"
const MAIL_COUNTRY = "Estados Unidos"

export const DATA_PROCESSORS: readonly DataProcessor[] = [
  {
    id: "servidor",
    name: "OVH SAS (OVHcloud)",
    short: SERVER_PROVIDER,
    purpose: "Alojar la aplicación y la base de datos, con copias de seguridad diarias.",
    data: "Todos los datos de la cuenta y de los pacientes.",
    receives: "Todos los datos, con copias diarias",
    country: SERVER_COUNTRY,
    use: { kind: "siempre" },
  },
  {
    id: "cloudflare",
    name: "Cloudflare, Inc. (Cloudflare R2 y Cloudflare Tunnel)",
    short: "Cloudflare",
    purpose:
      "Almacenar archivos (adjuntos, imágenes, documentos y copias de seguridad) y ser la entrada segura a la aplicación.",
    data: "Archivos que la clínica y sus pacientes suben o envían, copias de la base de datos y el tráfico hacia la aplicación.",
    receives: "Archivos e imágenes, copias de seguridad y la entrada segura a odentIA",
    country: "Estados Unidos",
    use: { kind: "siempre" },
  },
  {
    id: "correo",
    name: "Zoho Corporation (Zoho CPaaS, antes ZeptoMail)",
    short: MAIL_PROVIDER,
    purpose: "Enviar los correos del sistema: invitaciones, avisos, recetas y comprobantes.",
    data: "Nombre y correo del destinatario y contenido del mensaje.",
    receives: "Correos que envía odentIA: avisos, recetas y comprobantes",
    country: MAIL_COUNTRY,
    use: { kind: "siempre" },
  },
  {
    id: "transcripcion",
    name: "OpenAI, L.L.C. (transcripción)",
    short: "OpenAI (notas de voz)",
    purpose: "Pasar a texto las notas de voz que llegan por los canales.",
    data: "Audios de las notas de voz, que pueden incluir datos de salud.",
    receives: "Las notas de voz que llegan, para pasarlas a texto",
    country: "Estados Unidos",
    use: { kind: "siempre" },
  },
  {
    id: "geoapify",
    name: "Geoapify GmbH",
    short: "Geoapify",
    purpose: "Sugerir la dirección mientras se escribe en los datos de un paciente o en su registro.",
    data: "Solo el texto de la dirección que se escribe, sin el nombre de la persona.",
    receives: "El texto de la dirección mientras se escribe, para sugerirla",
    country: "Alemania",
    use: { kind: "siempre" },
  },
  {
    id: "google-places",
    name: "Google LLC (Google Maps Platform, Places)",
    short: "Google Maps",
    purpose: "Sugerir y ubicar la dirección de las sedes de la clínica.",
    data: "Solo el texto de la dirección de la sede que se escribe.",
    receives: "La dirección de las sedes, para ubicarlas",
    country: "Estados Unidos",
    use: { kind: "siempre" },
  },
  {
    id: "openai",
    name: "OpenAI, L.L.C. («ChatGPT 6»)",
    short: "OpenAI",
    purpose: "Modelo de inteligencia artificial de los agentes y del dictado en la atención.",
    data: "Conversaciones, dictados y datos de pacientes necesarios para la tarea, incluidos datos de salud.",
    receives: "Lo que escriben al agente y lo que se dicta en la atención",
    country: "Estados Unidos",
    use: { kind: "agentes" },
  },
  {
    id: "jev",
    name: "TypeSafe AI («Jev»)",
    short: "Jev",
    purpose: "Modelo de decisión de los agentes: entender qué pide cada mensaje para dirigirlo.",
    data: "Texto de los mensajes recibidos.",
    receives: "El texto de los mensajes que llegan, para entender qué piden",
    country: "Estados Unidos",
    use: { kind: "agentes" },
  },
  {
    id: "embeddings",
    name: "OpenAI, L.L.C. (búsqueda del agente)",
    short: "Búsqueda del agente",
    purpose: "Convertir el conocimiento de la clínica en vectores para que el agente busque en él.",
    data: "Textos que la clínica carga como conocimiento y consultas de búsqueda.",
    receives: "El conocimiento de la clínica y lo que se busca en él",
    country: "Estados Unidos",
    use: { kind: "agentes" },
  },
  {
    id: "voz-navegador",
    name: "Google LLC (reconocimiento de voz de Chrome)",
    short: "Google (voz en Chrome)",
    purpose: "Pasar a texto el dictado de la atención cuando se dicta en Chrome.",
    data: "El audio de lo que se dicta, que incluye datos de salud.",
    receives: "El audio del dictado, si se dicta en Chrome",
    country: "Estados Unidos",
    use: { kind: "dictado" },
  },
  {
    id: "meta",
    name: "Meta Platforms, Inc. (WhatsApp Business, Instagram, Messenger)",
    short: "Meta",
    purpose: "Enviar y recibir mensajes por esos canales, si la clínica los conecta.",
    data: "Nombre de perfil, número o identificador y contenido de los mensajes.",
    receives: "Número, nombre y mensajes",
    country: "Estados Unidos",
    use: { kind: "canal", providers: ["whatsapp_cloud_api", "instagram", "messenger"] },
  },
  {
    id: "telegram",
    name: "Telegram Messenger Inc.",
    short: "Telegram",
    purpose: "Enviar y recibir mensajes por Telegram, si la clínica lo conecta.",
    data: "Nombre de usuario, identificador y contenido de los mensajes.",
    receives: "Usuario y mensajes",
    country: "Islas Vírgenes Británicas y Emiratos Árabes Unidos",
    use: { kind: "canal", providers: ["telegram_bot_api"] },
  },
  {
    id: "gmail",
    name: "Google LLC (Gmail)",
    short: "Gmail (Google)",
    purpose: "Enviar y recibir correos desde la cuenta de la clínica, si la conecta.",
    data: "Direcciones y contenido de los correos.",
    receives: "Correos con pacientes",
    country: "Estados Unidos",
    use: { kind: "canal", providers: ["gmail"] },
  },
  {
    id: "microsoft365",
    name: "Microsoft Corporation (Microsoft 365)",
    short: "Microsoft 365",
    purpose: "Enviar y recibir correos desde la cuenta de la clínica, si la conecta.",
    data: "Direcciones y contenido de los correos.",
    receives: "Correos con pacientes",
    country: "Estados Unidos",
    use: { kind: "canal", providers: ["microsoft365"] },
  },
]

/** Los que intervienen siempre, para todas las clínicas. */
export const ALWAYS_PROCESSORS = DATA_PROCESSORS.filter((p) => p.use.kind === "siempre")
/** Los que dependen de lo que la clínica conecta o enciende. */
export const OPTIONAL_PROCESSORS = DATA_PROCESSORS.filter((p) => p.use.kind !== "siempre")
