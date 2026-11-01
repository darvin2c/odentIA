/**
 * Buscador rápido (Ctrl+K; ADR 0066): lo que la ventana necesita sin pintar
 * nada. Adónde lleva cada resultado, qué dice cada tipo, lo abierto hace poco
 * y los tipos que cada persona quitó con el filtro (los dos, solo en este
 * navegador: no son datos de la clínica).
 */
import { canAccessAny, platformPathPermission } from "@odentia/auth/permissions"
import { formatMoney } from "@odentia/clinical"

export const SEARCH_TYPES = [
  "persona",
  "cita",
  "conversacion",
  "clinica",
  "documento",
  "dinero",
  "tarea",
  "oportunidad",
  "servicio",
  "inventario",
  "equipo",
  "respuesta",
] as const
export type SearchType = (typeof SEARCH_TYPES)[number]

export type SearchTarget =
  | {
      screen: "persona"
      personId: string
      section?: "cuenta" | "plan" | "documentos" | "historia"
      budgetId?: string
      documentId?: string
    }
  | { screen: "cita"; appointmentId: string }
  | { screen: "conversacion"; conversationId: string }
  | { screen: "tarea"; taskId: string }
  | { screen: "oportunidad"; opportunityId: string }
  | { screen: "servicios"; q: string }
  | { screen: "promociones" }
  | { screen: "producto"; productId: string }
  | { screen: "compra"; purchaseOrderId: string }
  | { screen: "proveedores" }
  | { screen: "gastos"; spentAt: string }
  | { screen: "ticket"; ticketId: string; branchId: string }
  | { screen: "comisiones"; professionalUserId: string; year: number; month: number }
  | { screen: "agenda"; professionalUserId?: string; branchId?: string }
  | { screen: "conocimiento"; q: string }

export interface SearchMoney {
  cents: number
  currency: string
}

export interface SearchItem {
  id: string
  type: SearchType
  kind: string
  title: string
  detail: string | null
  at: string | null
  amount: SearchMoney | null
  matched: boolean
  target: SearchTarget
}

export interface SearchOwner {
  key: string
  kind: string
  type: SearchType
  id: string
  title: string
  badge: string
  detail: string | null
  matched: boolean
  target: SearchTarget
  items: SearchItem[]
  more: number
  amount?: SearchMoney | null
  /** El texto de una respuesta del agente, para copiarlo a quien no abre Conocimiento. */
  text?: string
}

export interface SearchResult {
  owners: SearchOwner[]
  meaning: SearchOwner[]
}

/** Nombre de cada tipo en el filtro, en el orden en que se muestran. */
export const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
  persona: "Personas",
  cita: "Citas",
  conversacion: "Conversaciones y mensajes",
  clinica: "Historia clínica",
  documento: "Documentos e imágenes",
  dinero: "Dinero",
  tarea: "Tareas",
  oportunidad: "Oportunidades",
  servicio: "Servicios y promociones",
  inventario: "Inventario y compras",
  equipo: "Equipo y sedes",
  respuesta: "Respuestas del agente",
}

/** Con qué permiso se ofrece cada tipo en el filtro (cualquiera de la lista). */
export const SEARCH_TYPE_PERMISSIONS: Record<SearchType, readonly string[] | null> = {
  persona: ["patients.read"],
  cita: ["appointments.read"],
  conversacion: ["conversations.read"],
  clinica: ["clinical.read"],
  documento: ["clinical.read"],
  dinero: ["finance.read", "budgets.read", "commissions.read"],
  tarea: ["tasks.read"],
  oportunidad: ["crm.read"],
  servicio: ["catalog.read"],
  inventario: ["inventory.read", "inventory.stock"],
  equipo: null,
  respuesta: ["conversations.read"],
}

/** Palabra de cada cosa en su fila: «Cita», «Mensaje», «Debe»… */
export const SEARCH_KIND_LABELS: Record<string, string> = {
  cita: "Cita",
  control: "Control",
  conversacion: "Conversación",
  mensaje: "Mensaje",
  debe: "Debe",
  presupuesto: "Presupuesto",
  comprobante: "Comprobante",
  gasto: "Gasto",
  comision: "Comisión",
  nota: "Nota",
  atencion: "Atención",
  diagnostico: "Diagnóstico",
  receta: "Receta",
  documento: "Documento",
  consentimiento: "Consentimiento",
  tarea: "Tarea",
  oportunidad: "Oportunidad",
  promocion: "Promoción",
  compra: "Compra",
  producto: "Producto",
}

/** Lo que dice Enter en la fila elegida. */
export function targetVerb(target: SearchTarget): string {
  switch (target.screen) {
    case "persona":
      return target.section === "cuenta"
        ? "Ver cobros"
        : target.section === "plan"
          ? "Abrir presupuesto"
          : target.section === "documentos"
            ? "Abrir en la ficha"
            : target.section === "historia"
              ? "Abrir en la ficha"
              : "Abrir ficha"
    case "cita":
      return "Ver en la Agenda"
    case "conversacion":
      return "Abrir en la Bandeja"
    case "tarea":
      return "Abrir tarea"
    case "oportunidad":
      return "Abrir oportunidad"
    case "servicios":
      return "Ver en Servicios"
    case "promociones":
      return "Ver promociones"
    case "producto":
      return "Ver producto"
    case "compra":
      return "Abrir compra"
    case "proveedores":
      return "Ver proveedores"
    case "gastos":
      return "Ver gastos"
    case "ticket":
      return "Ver el ticket"
    case "comisiones":
      return "Ver comisiones"
    case "agenda":
      return "Ver su agenda"
    case "conocimiento":
      return "Ver respuesta"
  }
}

/** La dirección que ya entiende cada pantalla. `timeZone`: la de la clínica, para el mes de un gasto. */
export function targetHref(target: SearchTarget, timeZone?: string): string {
  const query = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
    const text = search.toString()
    return text ? `?${text}` : ""
  }
  switch (target.screen) {
    case "persona":
      return `/people/${encodeURIComponent(target.personId)}${query({
        tab: target.section,
        budgetId: target.budgetId,
        documentId: target.documentId,
      })}`
    case "cita":
      return `/agenda${query({ appointmentId: target.appointmentId })}`
    case "conversacion":
      return `/inbox${query({ conversation: target.conversationId })}`
    case "tarea":
      return `/tasks${query({ task: target.taskId })}`
    case "oportunidad":
      return `/pipeline${query({ oportunidad: target.opportunityId })}`
    case "servicios":
      return `/services${query({ q: target.q })}`
    case "promociones":
      return "/services/promotions"
    case "producto":
      return `/inventory${query({ producto: target.productId })}`
    case "compra":
      return `/inventory${query({ tab: "compras", orden: target.purchaseOrderId })}`
    case "proveedores":
      return "/inventory?tab=proveedores"
    case "gastos": {
      const [year = "", month = ""] = new Date(target.spentAt)
        .toLocaleDateString("en-CA", { timeZone })
        .split("-")
      return `/finance${query({ tab: "gastos", year, month: String(Number(month)) })}`
    }
    case "ticket":
      return `/finance${query({ tab: "cobros", branch: target.branchId, ticket: target.ticketId })}`
    case "comisiones":
      // Comisiones lleva a Finanzas a quien la ve; quien solo ve las suyas se queda ahí.
      return `/commissions${query({ year: String(target.year), month: String(target.month), profesional: target.professionalUserId })}`
    case "agenda":
      return `/agenda${query({ who: target.professionalUserId, branch: target.branchId })}`
    case "conocimiento":
      return `/agent/knowledge${query({ q: target.q })}`
  }
}

/** La pantalla de destino se abre para este rol (las mismas reglas que el menú). */
export function canOpenHref(role: string, href: string): boolean {
  const pathname = href.split("?")[0] ?? href
  const permissions = platformPathPermission(pathname)
  return !permissions || canAccessAny(role, permissions)
}

/** Fecha corta de una fila: «hoy 16:30», «mañana 10:00», «15 oct». */
export function formatSearchWhen(
  iso: string,
  locale: string,
  timeZone: string,
  now = new Date(),
): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const day = (value: Date) => value.toLocaleDateString("en-CA", { timeZone })
  const today = day(now)
  const tomorrow = day(new Date(now.getTime() + 86_400_000))
  const yesterday = day(new Date(now.getTime() - 86_400_000))
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone })
  const hasTime = time !== "00:00"
  const when = day(date)
  if (when === today) return hasTime ? `hoy ${time}` : "hoy"
  if (when === tomorrow) return hasTime ? `mañana ${time}` : "mañana"
  if (when === yesterday) return "ayer"
  const sameYear = when.slice(0, 4) === today.slice(0, 4)
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  })
}

export function formatSearchMoney(amount: SearchMoney, locale: string): string {
  return formatMoney(amount.cents, amount.currency, locale)
}

// --- Lo de este navegador: abiertos hace poco y filtro --------------------

const RECENT_KEY = "odentia.buscador.recientes"
const FILTER_KEY = "odentia.buscador.sin"
const RECENT_MAX = 5

/** Solo el nombre: un documento o un teléfono no quedan guardados en el navegador. */
export interface RecentPerson {
  id: string
  title: string
}

/** De cada persona del equipo en cada clínica: en un computador compartido nadie ve lo de otro. */
function storageKey(base: string, scope: string): string {
  return `${base}:${scope}`
}

export function readRecents(scope: string): RecentPerson[] {
  try {
    const raw = window.localStorage.getItem(storageKey(RECENT_KEY, scope))
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (item): item is RecentPerson =>
              typeof item?.id === "string" && typeof item?.title === "string",
          )
          .slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

export function rememberRecent(scope: string, person: RecentPerson): void {
  try {
    const next = [
      { id: person.id, title: person.title },
      ...readRecents(scope).filter((item) => item.id !== person.id),
    ].slice(0, RECENT_MAX)
    window.localStorage.setItem(storageKey(RECENT_KEY, scope), JSON.stringify(next))
  } catch {
    // Sin almacenamiento (ventana privada): no se recuerda, y la ventana sigue igual.
  }
}

export function readHiddenTypes(scope: string): SearchType[] {
  try {
    const raw = window.localStorage.getItem(storageKey(FILTER_KEY, scope))
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed)
      ? parsed.filter((type): type is SearchType =>
          (SEARCH_TYPES as readonly string[]).includes(type),
        )
      : []
  } catch {
    return []
  }
}

export function saveHiddenTypes(scope: string, types: readonly SearchType[]): void {
  try {
    window.localStorage.setItem(storageKey(FILTER_KEY, scope), JSON.stringify(types))
  } catch {
    // Sin almacenamiento: el filtro vale solo mientras la ventana siga abierta.
  }
}

/** Lo escrito es una pregunta, no un nombre: «¿cómo bloqueo un horario?» no se ofrece como paciente nuevo. */
export function looksLikeQuestion(text: string): boolean {
  return /[¿?]/.test(text) || /^(c[oó]mo|d[oó]nde|qu[eé]|cu[aá]l|cu[aá]ndo|cu[aá]nt[oa]s?|qui[eé]n|por qu[eé]|porque|puedo|se puede|quiero|necesito|no puedo|no me|no encuentro)\b/i.test(text.trim())
}

/** Pide la pregunta a Ayuda (el panel la abre y la envía). */
export const ASK_HELP_EVENT = "odentia:preguntar-ayuda"

export function askHelp(question: string): void {
  window.dispatchEvent(new CustomEvent(ASK_HELP_EVENT, { detail: { question } }))
}
