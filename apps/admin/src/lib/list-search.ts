import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"

/*
 * Lo que la cola de soporte y la lista de espera leen de la dirección. Cada
 * clave va siempre, con `undefined` si su valor no sirve: TanStack Router junta
 * la búsqueda cruda de la dirección con la de la ruta (`{ ...cruda, ...ruta }`),
 * así que una clave que se omite deja pasar el valor crudo («?estado=todos») y
 * la pantalla lo mandaba a la API, que respondía 400.
 */

export const SUPPORT_STATUSES = ["abierto", "en_atencion", "esperando_clinica", "resuelto"] as const
export type SupportStatusFilter = (typeof SUPPORT_STATUSES)[number]
export const SUPPORT_KINDS = ["pregunta", "problema", "acceso", "cobro"] as const
export type SupportKindFilter = (typeof SUPPORT_KINDS)[number]

export interface SupportSearch {
  /** El caso abierto: lo usa también el enlace del aviso por correo. */
  caso?: string | undefined
  clinica?: string | undefined
  tipo?: SupportKindFilter | undefined
  quien?: "mios" | "sin" | undefined
  /** Sin estado: los que no están resueltos. */
  estado?: SupportStatusFilter | undefined
  pestana?: "conocimiento" | "metricas" | undefined
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined

export function supportSearchOf(search: Record<string, unknown>): SupportSearch {
  return {
    caso: text(search.caso),
    clinica: text(search.clinica),
    tipo: oneOf(SUPPORT_KINDS, search.tipo),
    quien: oneOf(["mios", "sin"] as const, search.quien),
    estado: oneOf(SUPPORT_STATUSES, search.estado),
    pestana: oneOf(["conocimiento", "metricas"] as const, search.pestana),
  }
}

/**
 * Las etapas las calcula el servidor al leer (nadie las mueve a mano): la
 * invitación que vence pasa sola a «Invitación vencida» y la clínica con un
 * pago confirmado, a «Paga».
 */
export const WAITLIST_STAGES = [
  "por_revisar",
  "invitada",
  "invitacion_vencida",
  "entro",
  "paga",
  "descartada",
] as const
export type WaitlistStageName = (typeof WAITLIST_STAGES)[number]
export type WaitlistStageFilter = WaitlistStageName | "todas"
export const WAITLIST_STAGE_FILTERS: readonly WaitlistStageFilter[] = [...WAITLIST_STAGES, "todas"]
export const isWaitlistStageFilter = (value: unknown): value is WaitlistStageFilter =>
  typeof value === "string" && (WAITLIST_STAGE_FILTERS as readonly string[]).includes(value)

export interface WaitlistSearch {
  /** Sin etapa: «Por revisar». */
  etapa?: WaitlistStageFilter | undefined
  producto?: ClinicalProduct | undefined
  q?: string | undefined
  solicitud?: string | undefined
  /** El nombre de antes de `etapa`: se lee y no se vuelve a escribir. */
  estado?: undefined
}

export function waitlistSearchOf(search: Record<string, unknown>): WaitlistSearch {
  // `estado` es el nombre de antes: un enlace guardado con «?estado=entro» abre esa etapa.
  const etapa = isWaitlistStageFilter(search.etapa)
    ? search.etapa
    : isWaitlistStageFilter(search.estado)
      ? search.estado
      : undefined
  return {
    etapa: etapa === "por_revisar" ? undefined : etapa,
    producto: isClinicalProduct(search.producto) ? search.producto : undefined,
    // Un enlace con «?q=987654321» llega como número: también es una búsqueda.
    q:
      (typeof search.q === "string" && search.q) || typeof search.q === "number"
        ? String(search.q)
        : undefined,
    solicitud: typeof search.solicitud === "string" ? search.solicitud : undefined,
    estado: undefined,
  }
}

/**
 * La etapa y el producto que miraba la lista de espera, recordados en esta
 * pestaña: «Abrir solicitud» de Inicio abre el cajón con la lista de detrás
 * como estaba. Es solo una comodidad de quien mira: sin almacenamiento, la
 * lista abre en «Por revisar» y «Todos».
 */
export type WaitlistFilters = Pick<WaitlistSearch, "etapa" | "producto">

const WAITLIST_KEY = "admin.waitlist.filters"

export function rememberWaitlistFilters(filters: WaitlistFilters): void {
  try {
    sessionStorage.setItem(
      WAITLIST_KEY,
      JSON.stringify({ etapa: filters.etapa, producto: filters.producto }),
    )
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): la lista abre limpia.
  }
}

export function rememberedWaitlistFilters(): WaitlistFilters {
  try {
    const raw = JSON.parse(sessionStorage.getItem(WAITLIST_KEY) ?? "{}") as Record<string, unknown>
    const { etapa, producto } = waitlistSearchOf({ etapa: raw.etapa, producto: raw.producto })
    return { ...(etapa ? { etapa } : {}), ...(producto ? { producto } : {}) }
  } catch {
    return {}
  }
}

/*
 * Clientes del ARM (`/clients`) y la ficha de un cliente (`/clients/<id>`).
 * Las mismas reglas: cada clave va siempre, con `undefined` si su valor no sirve.
 */

/** Las vistas de la lista, como las cuenta el servidor (`CLIENT_VIEWS`). Sin vista: «Por vender». */
export const CLIENT_LIST_VIEWS = [
  "por_vender",
  "con_cuenta",
  "no_por_ahora",
  "perdidos",
  "todos",
] as const
export type ClientListView = (typeof CLIENT_LIST_VIEWS)[number]
/** Las etapas que calcula el servidor (`CLIENT_STAGES`): nadie las mueve a mano. */
export const CLIENT_STAGE_NAMES = [
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
  "entro",
  "no_por_ahora",
  "perdido",
] as const
export type ClientStageName = (typeof CLIENT_STAGE_NAMES)[number]
export const CLIENT_ORIGIN_NAMES = [
  "web",
  "referido",
  "evento",
  "whatsapp",
  "redes",
  "busqueda",
  "otro",
] as const
export type ClientOriginName = (typeof CLIENT_ORIGIN_NAMES)[number]

export interface ClientsSearch {
  vista?: ClientListView | undefined
  producto?: ClinicalProduct | undefined
  /** Un usuario del equipo, «mio» o «sin» (sin responsable). */
  responsable?: string | undefined
  origen?: ClientOriginName | undefined
  etapa?: ClientStageName | undefined
  q?: string | undefined
  /** Desde la 2: la 1 no se escribe. */
  pagina?: number | undefined
}

const pageOf = (value: unknown): number | undefined => {
  const page =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isInteger(page) && page > 1 && page <= 1000 ? page : undefined
}
const personKey = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\w-]{1,120}$/.test(value) ? value : undefined

export function clientsSearchOf(search: Record<string, unknown>): ClientsSearch {
  const vista = oneOf(CLIENT_LIST_VIEWS, search.vista)
  return {
    vista: vista === "por_vender" ? undefined : vista,
    producto: isClinicalProduct(search.producto) ? search.producto : undefined,
    responsable: personKey(search.responsable),
    origen: oneOf(CLIENT_ORIGIN_NAMES, search.origen),
    etapa: oneOf(CLIENT_STAGE_NAMES, search.etapa),
    q:
      (typeof search.q === "string" && search.q) || typeof search.q === "number"
        ? String(search.q)
        : undefined,
    pagina: pageOf(search.pagina),
  }
}

/**
 * Lo que la lista de Clientes miraba, recordado en esta pestaña: «← Clientes»
 * de la ficha vuelve a la lista como estaba. Sin almacenamiento, abre limpia.
 */
const CLIENTS_KEY = "admin.clients.search"

export function rememberClientsSearch(search: ClientsSearch): void {
  try {
    sessionStorage.setItem(CLIENTS_KEY, JSON.stringify(search))
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): la lista abre limpia.
  }
}

export function rememberedClientsSearch(): ClientsSearch {
  try {
    return clientsSearchOf(
      JSON.parse(sessionStorage.getItem(CLIENTS_KEY) ?? "{}") as Record<string, unknown>,
    )
  } catch {
    return clientsSearchOf({})
  }
}

/** Las pestañas de la ficha de un cliente, en su orden. */
export const CLIENT_TABS = [
  "resumen",
  "historial",
  "contactos",
  "venta",
  "alta",
  "pagos",
  "uso",
  "soporte",
  "documentos",
] as const
export type ClientTab = (typeof CLIENT_TABS)[number]
/** Los filtros del historial (`TIMELINE_FILTERS`). Sin filtro: «Todo». */
export const CLIENT_HISTORY_FILTERS = ["todo", "contactos", "venta", "cuenta", "soporte"] as const
export type ClientHistoryFilter = (typeof CLIENT_HISTORY_FILTERS)[number]

export interface ClientSearch {
  /** Sin pestaña: Resumen. */
  tab?: ClientTab | undefined
  historial?: ClientHistoryFilter | undefined
}

export function clientSearchOf(search: Record<string, unknown>): ClientSearch {
  const tab = oneOf(CLIENT_TABS, search.tab)
  const historial = oneOf(CLIENT_HISTORY_FILTERS, search.historial)
  return {
    tab: tab === "resumen" ? undefined : tab,
    historial: historial === "todo" ? undefined : historial,
  }
}

/**
 * Lo que abre en Clientes un enlace de antes a la lista de espera: la etapa de
 * la solicitud pasa a la vista que la contiene, con su producto y su búsqueda.
 */
export function clientsSearchFromWaitlist(search: WaitlistSearch): ClientsSearch {
  const vista: ClientListView | undefined =
    search.etapa === "entro" || search.etapa === "paga"
      ? "con_cuenta"
      : search.etapa === "descartada"
        ? "perdidos"
        : search.etapa === "todas"
          ? "todos"
          : undefined
  return clientsSearchOf({ vista, producto: search.producto, q: search.q })
}

/**
 * La pestaña de la ficha del cliente que corresponde a la de la ficha de la
 * clínica de antes (`/organizations/<id>?tab=`).
 */
export function clientTabFromOrganization(tab: string | undefined): ClientTab | undefined {
  const tabs: Record<string, ClientTab | undefined> = {
    resumen: undefined,
    gastos: "uso",
    precio: "pagos",
    equipo: "contactos",
    actividad: "historial",
    carga: "alta",
  }
  return tab ? tabs[tab] : undefined
}
