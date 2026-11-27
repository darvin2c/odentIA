import { SUPPORT_STATUS_WORDS } from "./plan"

/**
 * Lo que la pantalla sabe de la Ayuda (entrega 7, tablero 19): la guía para el rol de quien la
 * abre, armada en el servidor con la matriz de permisos (`apps/api/src/ayuda.ts`), y sus
 * preguntas al equipo de gestorIA con sus respuestas.
 */

export interface HelpFaq {
  id: string
  q: string
  a: string[]
  /** «Dueño, Administrador y Ventas». */
  who: string
  whoCount: number
  /** Si el rol de quien lee puede hacerlo. */
  you: boolean
  /** Su pantalla dentro de la tienda, solo si quien lee puede abrirla. */
  screen: { label: string; path: string } | null
}

export interface HelpQuestion {
  /** El caso en la administración; null mientras no vuelve entre sus casos. */
  id: string | null
  question: string
  createdAt: string
  status: string
  replies: { body: string; at: string }[]
}

export interface HelpView {
  /** El rol de quien la abre, con su nombre. */
  role: string
  /** Si su rol puede escribirle al equipo de gestorIA. */
  canAsk: boolean
  /** gestorIA está conectada a la administración: si no, las preguntas no salen. */
  connected: boolean
  guide: { id: string; title: string; faqs: HelpFaq[] }[]
  questions: HelpQuestion[]
}

export const HELP_KEY = (storeId: string) => ["ayuda", storeId]

/** «Lo pueden hacer: Dueño, Administrador y Ventas.» */
export function whoLine(faq: Pick<HelpFaq, "who" | "whoCount">): string {
  return `${faq.whoCount === 1 ? "Lo puede hacer" : "Lo pueden hacer"}: ${faq.who}.`
}

/** Cómo va una pregunta: por salir, enviada o lo que dice la administración de su caso. */
export function questionStatus(status: string): string {
  if (status === "por_enviar") return "Por enviar"
  if (status === "enviada") return "Enviada"
  return SUPPORT_STATUS_WORDS[status] ?? "Recibida"
}

/** Las pantallas de la tienda por su ruta, con el nombre que les da el menú. */
const SCREENS: [path: string, name: string][] = [
  ["/despachos", "Despachos"],
  ["/pedidos", "Pedidos"],
  ["/clientes", "Clientes"],
  ["/catalogo", "Catálogo"],
  ["/caja", "Caja"],
  ["/reportes", "Reportes"],
  ["/configuracion/datos", "Datos de la tienda"],
  ["/configuracion/marca", "Tu marca"],
  ["/configuracion/equipo", "Equipo y repartidores"],
  ["/configuracion/sofi", "Sofi"],
  ["/configuracion/medios-de-pago", "Cobros"],
  ["/configuracion/entregas", "Entregas"],
  ["/configuracion/avisos", "Avisos al celular"],
  ["/configuracion/plan", "Plan y pagos"],
  // «Lo que falta» es la entrada de Configuración: después de sus apartados.
  ["/configuracion", "Lo que falta"],
  ["/ayuda", "Ayuda"],
]

/**
 * La pantalla desde la que se pide ayuda, a partir de la dirección de la tienda
 * (`/tiendas/<id>/pedidos?pedido=…`): su ruta dentro de la tienda (la que se envía) y su nombre
 * (el que ve la persona). Fuera de una sección conocida, su inicio.
 */
export function screenOf(href: string, storeId: string): { path: string; name: string } {
  const base = `/tiendas/${storeId}`
  const inside = href.startsWith(base) ? href.slice(base.length) : ""
  const path = (inside.startsWith("/") ? inside : `/${inside}`).slice(0, 200)
  const section = path.split(/[?#]/, 1)[0] ?? "/"
  const known = SCREENS.find(([prefix]) => section === prefix || section.startsWith(`${prefix}/`))
  return { path, name: known?.[1] ?? "Inicio de la tienda" }
}
