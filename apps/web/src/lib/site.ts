// Mapa de la web, enlaces a la aplicación y textos que se repiten en varias páginas.
import { giftOf, type Pricing } from "./pricing"
import { DEFAULT_DOMAIN, MEDICAL, WORDS } from "./product"

const domain = import.meta.env.VITE_BASE_DOMAIN || DEFAULT_DOMAIN
const port = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

/** La cuenta de la clínica vive en el panel; la web solo enlaza a registrarse e ingresar. */
export const registerUrl = `https://app.${domain}${port}/register`
export const loginUrl = `https://app.${domain}${port}/login`
export const contactEmail = `hola@${domain}`
export const privacyEmail = `privacidad@${domain}`
/** La solicitud de la lista de espera (Fundadores) va a la ruta pública de la API, en api.<dominio>. */
export const waitlistApiUrl = `https://api.${domain}${port}/api/public/founders/waitlist`

/**
 * La llamada a la acción de toda la web, con el regalo del plan que se
 * muestra (Fundadores, issue 165). Mientras se entra por invitación lleva a
 * la lista de espera; con el alta abierta, al registro.
 */
export function ctaOf(pricing: Pricing): { href: string; label: string } {
  const gift = giftOf(pricing)
  return pricing.signupMode === "invitacion"
    ? { href: "/solicitar-invitacion", label: gift ? `Pide tus ${gift}` : "Solicita tu invitación" }
    : { href: registerUrl, label: gift ? `Obtén ${gift} de crédito` : "Crear mi cuenta" }
}

export type NavLink = { href: string; label: string }

/** Una fila de un menú desplegable: una línea de lo que hay y, en los agentes, su color (sobre claro). */
export type MenuItem = NavLink & { text: string; color?: string }

/** Un menú desplegable de la cabecera; `all` lleva a la página que reúne todo (`short`, en el teléfono). */
export type NavMenu = { items: MenuItem[]; all?: NavLink & { short: string }; columns?: 1 | 2 }

/** Una entrada de la cabecera: un enlace o, con `menu`, un desplegable. */
export type NavEntry = NavLink & { menu?: NavMenu }

/** Los tres agentes de cada web (lienzo del paso 3, tablero 1): su color y lo que hace cada uno. */
const agentsMenu: NavMenu = MEDICAL
  ? {
      items: [
        { href: "/agentes/recepcion", label: "Sofi · recepción", text: "Responde a cualquier hora, agenda y reconoce una urgencia.", color: "#0e7490" },
        { href: "/agentes/asistente-clinico", label: "Clío · consulta", text: "Dictas y ordena la consulta: signos vitales, examen, receta y descanso.", color: "#1f9d7a" },
        { href: "/agentes/administrador", label: "Argos · administración", text: "Trae de vuelta a tus pacientes y responde lo que le preguntes.", color: "#c98a1c" },
      ],
      all: { href: "/agentes", label: "Los tres juntos, en una consulta de principio a fin", short: "Los tres juntos" },
    }
  : {
      items: [
        { href: "/agentes/recepcion", label: "Sofi · recepción", text: "Responde, informa y agenda por todos tus canales, a cualquier hora.", color: "#0e7490" },
        { href: "/agentes/asistente-clinico", label: "Clío · consulta", text: "Dictas la consulta y prepara la nota, el odontograma y el presupuesto.", color: "#1f9d7a" },
        { href: "/agentes/administrador", label: "Argos · administración", text: "Trae de vuelta a tus pacientes y responde lo que le preguntes de tu clínica.", color: "#c98a1c" },
      ],
      all: { href: "/agentes", label: "Los tres juntos, en un caso de principio a fin", short: "Los tres juntos" },
    }

/** «El sistema» de latidIA: lo que tiene el consultorio, en dos columnas. */
const systemMenu: NavMenu = {
  columns: 2,
  items: [
    { href: "/historia-clinica-electronica", label: "Historia clínica y signos vitales", text: "Examen por sistemas, antecedentes y su presión en el tiempo." },
    { href: "/receta-y-descanso-medico", label: "Receta y descanso médico", text: "Avisa embarazo y alergias; el descanso, firmado y numerado." },
    { href: "/agenda-medica", label: "Agenda y controles", text: "Por sala y por médico, con controles que se repiten." },
    { href: "/caja-y-cobros", label: "Caja y varias sedes", text: "Cada consulta cobrada, en cada sede." },
    { href: "/reportes", label: "Reportes con Argos", text: "Lo que te deja el mes, y pregúntale lo que quieras saber." },
    { href: "/portal-del-paciente", label: "Su enlace", text: "Tu paciente ve su cita, sus datos y sus papeles." },
    { href: "/seguridad", label: "Seguridad y datos de salud", text: "Cada rol ve solo lo suyo." },
  ],
}

export const mainNav: NavEntry[] = MEDICAL
  ? [
      { href: "/agentes", label: "Agentes", menu: agentsMenu },
      { href: "/historia-clinica-electronica", label: "El sistema", menu: systemMenu },
      { href: "/omnicanal", label: "Omnicanal" },
      { href: "/precios", label: "Precios" },
    ]
  : [
      { href: "/omnicanal", label: "Omnicanal" },
      { href: "/agentes", label: "Agentes", menu: agentsMenu },
      { href: "/precios", label: "Precios" },
      { href: "/seguridad", label: "Seguridad" },
    ]

export const footerGroups: { title: string; links: NavLink[] }[] = MEDICAL
  ? [
      {
        title: "Agentes",
        links: [
          { href: "/agentes", label: "Los tres agentes" },
          { href: "/agentes/recepcion", label: "Sofi · recepción" },
          { href: "/agentes/asistente-clinico", label: "Clío · consulta" },
          { href: "/agentes/administrador", label: "Argos · administración" },
        ],
      },
      {
        title: "El sistema",
        links: [
          { href: "/historia-clinica-electronica", label: "Historia clínica y signos vitales" },
          { href: "/receta-y-descanso-medico", label: "Receta y descanso médico" },
          { href: "/agenda-medica", label: "Agenda y controles" },
          { href: "/caja-y-cobros", label: "Caja y varias sedes" },
          { href: "/reportes", label: "Reportes" },
          { href: "/portal-del-paciente", label: "Su enlace" },
        ],
      },
      {
        title: WORDS.name,
        links: [
          { href: "/omnicanal", label: "Omnicanal y WhatsApp" },
          { href: "/precios", label: "Precios" },
          { href: "/seguridad", label: "Seguridad" },
          { href: "/solicitar-invitacion", label: "Pide tu invitación" },
          { href: "/contacto", label: "Habla con nosotros" },
        ],
      },
    ]
  : [
  {
    title: "Agentes",
    links: [
      { href: "/agentes", label: "Los tres agentes" },
      { href: "/agentes/recepcion", label: "Sofi · recepción" },
      { href: "/agentes/asistente-clinico", label: "Clío · consulta" },
      { href: "/agentes/administrador", label: "Argos · administración" },
    ],
  },
  {
    title: "Omnicanal",
    links: [
      { href: "/omnicanal", label: "Todos los canales" },
      { href: "/whatsapp-para-clinicas-dentales", label: "WhatsApp para clínicas" },
    ],
  },
  {
    title: "El sistema",
    links: [
      { href: "/agenda-odontologica", label: "Agenda" },
      { href: "/historia-clinica-y-odontograma", label: "Historia y odontograma" },
      { href: "/presupuestos-dentales", label: "Presupuestos" },
      { href: "/caja-y-cobros", label: "Caja y cobros" },
      { href: "/portal-del-paciente", label: "Su enlace" },
      { href: "/reportes", label: "Reportes" },
      { href: "/varias-sedes", label: "Varias sedes" },
    ],
  },
  {
    title: "odentIA",
    links: [
      { href: "/precios", label: "Precios" },
      { href: "/seguridad", label: "Seguridad" },
      { href: "/contacto", label: "Habla con nosotros" },
    ],
  },
]

/** Dónde se habla con una persona: la página de contacto de cada web. */
export const contactHref = "/contacto"

export const legalLinks: NavLink[] = [
  { href: "/terminos", label: "Términos" },
  { href: "/privacidad", label: "Privacidad" },
  { href: "/cookies", label: "Cookies" },
  { href: "/encargo-de-tratamiento", label: "Encargo de tratamiento" },
  { href: "/subencargados", label: "Subencargados" },
  { href: "/aviso-legal", label: "Aviso legal" },
  { href: "/pe/libro-de-reclamaciones", label: "Libro de reclamaciones (Perú)" },
]

/** Colores de cada agente: sobre fondo oscuro y sobre fondo claro. */
export const AGENT_COLORS = {
  recepcion: { dark: "#4fc3d7", light: "#0e7490" },
  clinico: { dark: "#a6f0d8", light: "#1f9d7a" },
  administrador: { dark: "#f5c46b", light: "#c98a1c" },
} as const
