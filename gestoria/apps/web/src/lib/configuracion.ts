import type { MyStore } from "./api"
import { STATUS_WORDS } from "./plan"
import type { DeliveryCost, DeliveryType, PaymentCollection, PaymentTypeCode } from "./tienda"
import { money } from "./tienda"

/**
 * Configuración, al pie del menú (lienzo «gestorIA · Configuración, de nuevo», tablero 3): abre con
 * «Lo que falta» y sigue en grupos con nombres de tarea (tu tienda, vender, conexiones, tu equipo,
 * para ti, tu cuenta). Cada apartado lo ve quien puede cambiarlo (`needs`, de
 * `apps/api/src/permisos.ts`): Ventas no ve lo que no puede tocar. Soporte de gestorIA, que solo
 * mira, ve lo que su permiso deja leer (`support`), sin cambiar nada.
 *
 * Los nombres son los títulos de cada página y los de la guía de la Ayuda (`HELP_SCREENS`).
 */
export type ConfigSectionId =
  | "falta"
  | "datos"
  | "marca"
  | "sofi"
  | "pagos"
  | "entregas"
  | "integraciones"
  | "equipo"
  | "avisos"
  | "plan"

export interface ConfigSection {
  id: ConfigSectionId
  label: string
  /** Dentro de la tienda: `/configuracion…`. */
  path: string
  needs: string
  /** Soporte lo mira (lo lee con `tienda.ver` o `equipo.ver`). */
  support: boolean
}

export interface ConfigGroup {
  label: string
  items: ConfigSection[]
}

export const CONFIG_PATH = "/configuracion"

/**
 * Donde abre Configuración: lo que falta para vender y cómo está cada parte. Es la raíz: así el
 * menú marca Configuración en cualquiera de sus partes. «Datos de la tienda», que estaba aquí,
 * pasó a `/configuracion/datos`.
 */
export const CONFIG_HOME_PATH = CONFIG_PATH

const SECTIONS: Record<ConfigSectionId, ConfigSection> = {
  falta: {
    id: "falta",
    label: "Lo que falta",
    path: CONFIG_HOME_PATH,
    needs: "configuracion",
    support: true,
  },
  datos: {
    id: "datos",
    label: "Datos de la tienda",
    path: `${CONFIG_PATH}/datos`,
    needs: "configuracion",
    support: true,
  },
  marca: {
    id: "marca",
    label: "Tu marca",
    path: `${CONFIG_PATH}/marca`,
    needs: "configuracion",
    support: true,
  },
  // «Probar a Sofi» sirve al ajustarla: es de quien cambia la configuración.
  sofi: {
    id: "sofi",
    label: "Sofi",
    path: `${CONFIG_PATH}/sofi`,
    needs: "configuracion",
    support: false,
  },
  pagos: {
    id: "pagos",
    label: "Cobros",
    path: `${CONFIG_PATH}/medios-de-pago`,
    needs: "configuracion",
    support: true,
  },
  entregas: {
    id: "entregas",
    label: "Entregas",
    path: `${CONFIG_PATH}/entregas`,
    needs: "configuracion",
    support: true,
  },
  // Su pantalla llega con su entrega (tablero 5): hasta entonces no se muestra (`INTEGRATIONS_READY`).
  integraciones: {
    id: "integraciones",
    label: "Integraciones",
    path: `${CONFIG_PATH}/integraciones`,
    needs: "configuracion",
    support: false,
  },
  equipo: {
    id: "equipo",
    label: "Equipo y repartidores",
    path: `${CONFIG_PATH}/equipo`,
    needs: "equipo.gestionar",
    support: true,
  },
  // Lo de cada persona (tablero 15): todo el equipo elige qué le llega al celular.
  avisos: {
    id: "avisos",
    label: "Avisos al celular",
    path: `${CONFIG_PATH}/avisos`,
    needs: "avisos.recibir",
    support: false,
  },
  plan: {
    id: "plan",
    label: "Plan y pagos",
    path: `${CONFIG_PATH}/plan`,
    needs: "plan",
    support: false,
  },
}

/**
 * Integraciones (chats, cobros y envíos) es su propia parte, pero una pantalla nueva entra en su
 * lugar, no antes: se enciende en la entrega que la trae, junto con su ruta en `main.tsx` y su
 * pregunta en la Ayuda.
 */
export const INTEGRATIONS_READY = false

/**
 * «Lo que falta» va arriba, sola. `SectionNav` todavía no tiene entradas sueltas antes de los
 * grupos (las suyas van al final): por eso va en un grupo propio, «Resumen».
 */
export const CONFIG_GROUPS: readonly ConfigGroup[] = [
  { label: "Resumen", items: [SECTIONS.falta] },
  { label: "Tu tienda", items: [SECTIONS.datos, SECTIONS.marca] },
  { label: "Vender", items: [SECTIONS.sofi, SECTIONS.pagos, SECTIONS.entregas] },
  { label: "Conexiones", items: INTEGRATIONS_READY ? [SECTIONS.integraciones] : [] },
  { label: "Tu equipo", items: [SECTIONS.equipo] },
  { label: "Para ti", items: [SECTIONS.avisos] },
  { label: "Tu cuenta gestorIA", items: [SECTIONS.plan] },
]

type Seat = Pick<MyStore, "role" | "permissions">

export function seesSection(store: Seat, section: ConfigSection): boolean {
  return store.permissions.includes(section.needs) || (store.role === "support" && section.support)
}

/** Los grupos con lo que ve quien está; sin los que quedan vacíos. */
export function configGroupsFor(store: Seat): ConfigGroup[] {
  return CONFIG_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => seesSection(store, item)),
  })).filter((group) => group.items.length > 0)
}

/** Donde abre Configuración para quien está: «Lo que falta» o, si no la ve, lo primero suyo. */
export function configEntryFor(store: Seat): ConfigSection | null {
  return configGroupsFor(store)[0]?.items[0] ?? null
}

/** El apartado de una ruta de la tienda (`/configuracion/marca`), o null si no es uno. */
export function configSectionOf(path: string): ConfigSection | null {
  return CONFIG_GROUPS.flatMap((group) => group.items).find((item) => item.path === path) ?? null
}

export function sectionById(id: ConfigSectionId): ConfigSection {
  return SECTIONS[id]
}

/*
 * «Lo que falta para vender» (tablero 3): lo que manda el servidor
 * (`GET /api/tiendas/:id/configuracion/resumen`), con lo guardado en cada apartado, y las
 * palabras de la pantalla. Nada se marca a mano.
 */

type SetupStep = "datos" | "catalogo" | "pagos" | "entregas" | "chats" | "sofi" | "equipo"

export interface ConfigOverview {
  steps: { step: SetupStep; state: "hecho" | "falta" | "saltado" | "pronto"; skippable: boolean }[]
  brand: {
    publicName: string | null
    brandColor: string | null
    logo: boolean
    link: string | null
  }
  catalog: { products: number; withStock: number }
  payments: { name: string; typeCode: PaymentTypeCode; collection: PaymentCollection }[]
  /** La pasarela del link de pago: solo si está conectada y con qué. */
  paymentLink: { provider: "mercadopago" } | null
  deliveries: {
    name: string
    type: DeliveryType
    cost: DeliveryCost
    zones: number
    acceptsPayOnDelivery: boolean
  }[]
  slots: number
  team: {
    members: number
    invitations: number
    /** Los repartidores que no son del equipo (nombres externos). */
    couriers: string[]
    /** Las personas del equipo, por su nombre. */
    names: string[]
    /** Pedidos de soporte para mirar la tienda, sin responder. */
    supportAsks: number
  }
  /** Null para soporte: no mira Sofi. */
  sofi: { enabled: boolean; tried: boolean } | null
  /** Solo para quien ve el plan; null si todavía no se sabe nada de él. */
  plan: {
    name: string | null
    status: keyof typeof STATUS_WORDS | null
    creditLeftCents: number | null
    currency: string | null
  } | null
}

export const PROVIDER_NAMES: Record<
  NonNullable<ConfigOverview["paymentLink"]>["provider"],
  string
> = {
  mercadopago: "Mercado Pago",
}

/** «Yape», «Yape y Plin», «Yape, Plin y BCP». */
export function listText(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Una cosa por hacer (o ya hecha) para vender, con su botón. */
export interface ToDoItem {
  id: "datos" | "catalogo" | "marca" | "pagos" | "link" | "entregas" | "sofi"
  state: "hecho" | "falta" | "saltado"
  title: string
  /** Cómo está, en una línea. */
  detail: string
  /** Lo que lo resuelve: su botón, con la ruta dentro de la tienda. */
  action: { label: string; path: string }
}

/** Lo que falta para vender, en su orden: lo hecho queda con su ✓ y lo pendiente, con su botón. */
export function toDoItems(overview: ConfigOverview, store: Pick<MyStore, "name">): ToDoItem[] {
  const stepOf = (step: SetupStep) => overview.steps.find((s) => s.step === step)?.state
  const items: ToDoItem[] = []
  const country = stepOf("datos") === "hecho"
  items.push({
    id: "datos",
    state: country ? "hecho" : "falta",
    title: "El país y la hora de tu tienda",
    detail: country
      ? "Con su hora se cuentan «hoy», los reportes y las promociones."
      : "Con su hora se cuentan «hoy» y los reportes; con el país, el plan.",
    action: { label: country ? "Ver" : "Completar", path: SECTIONS.datos.path },
  })
  const { products, withStock } = overview.catalog
  items.push({
    id: "catalogo",
    state: withStock > 0 ? "hecho" : "falta",
    title: "Tu catálogo con precios y stock",
    detail:
      withStock > 0
        ? plural(withStock, "producto con stock", "productos con stock")
        : products > 0
          ? `${plural(products, "producto", "productos")}, todavía sin stock.`
          : "Sube tus productos con sus tallas, precios y stock.",
    action: { label: withStock > 0 ? "Ver" : "Ir al catálogo", path: "/catalogo" },
  })
  const { logo, brandColor } = overview.brand
  items.push({
    id: "marca",
    state: logo && brandColor ? "hecho" : "falta",
    title: "Tu marca: logo y color",
    detail:
      logo && brandColor
        ? `Así te ven tus clientes${overview.brand.publicName ? `: ${overview.brand.publicName}` : `: ${store.name}`}.`
        : !logo && !brandColor
          ? "Sin logo y con el color de gestorIA."
          : !logo
            ? "Falta tu logo."
            : "Falta el color de tu marca.",
    action: { label: logo && brandColor ? "Ver" : "Completar", path: SECTIONS.marca.path },
  })
  const names = overview.payments.map((p) => p.name)
  items.push({
    id: "pagos",
    state: names.length > 0 ? "hecho" : "falta",
    title: "Cómo te pagan",
    detail: names.length > 0 ? listText(names) : "Yape, Plin, transferencia o al recibir.",
    action: { label: names.length > 0 ? "Ver" : "Agregar un medio", path: SECTIONS.pagos.path },
  })
  const byCapture = overview.payments
    .filter((p) => p.collection === "comprobante")
    .map((p) => p.name)
  items.push({
    id: "link",
    state: overview.paymentLink ? "hecho" : "falta",
    title: "Cobrar por link de pago",
    detail: overview.paymentLink
      ? `Con ${PROVIDER_NAMES[overview.paymentLink.provider]}: el pago se confirma solo.`
      : byCapture.length > 0
        ? `El pago se confirma solo. Ya cobras con ${listText(byCapture)} por captura.`
        : "El pago se confirma solo, sin revisar capturas.",
    action: {
      label: overview.paymentLink ? "Ver" : "Conectar pasarela",
      path: SECTIONS.pagos.path,
    },
  })
  const deliveries = overview.deliveries.map((d) => d.name)
  items.push({
    id: "entregas",
    state: deliveries.length > 0 ? "hecho" : "falta",
    title: "Cómo entregas",
    detail:
      deliveries.length > 0
        ? listText(deliveries)
        : "Tu reparto, el recojo en la tienda o la agencia, con su precio.",
    action: {
      label: deliveries.length > 0 ? "Ver" : "Agregar una forma",
      path: SECTIONS.entregas.path,
    },
  })
  // Soporte no mira Sofi: su paso no se le muestra.
  if (overview.sofi) {
    const sofi = stepOf("sofi")
    items.push({
      id: "sofi",
      state: sofi === "hecho" ? "hecho" : sofi === "saltado" ? "saltado" : "falta",
      title: "Probar a Sofi",
      detail:
        sofi === "hecho"
          ? "Ya le escribiste como una clienta."
          : sofi === "saltado"
            ? "Dijiste que no la usas por ahora."
            : "Escríbele como una clienta y mira cómo vende con tus precios.",
      action: { label: sofi === "hecho" ? "Ver" : "Probar a Sofi", path: SECTIONS.sofi.path },
    })
  }
  return items
}

/** «Para vender te faltan 2 cosas» o, con todo listo, que ya está. */
export function toDoTitle(items: readonly ToDoItem[]): string {
  const left = items.filter((item) => item.state === "falta").length
  if (left === 0) return "Tienes todo para vender"
  return left === 1 ? "Para vender te falta 1 cosa" : `Para vender te faltan ${left} cosas`
}

/** Cómo está una parte, en una línea, y si tiene algo pendiente (su punto naranja). */
export interface ConfigLine {
  id: ConfigSectionId
  summary: string
  status: string
  pending: boolean
}

const DELIVERY_SHORT: Partial<Record<DeliveryType, string>> = {
  OnSitePickup: "recojo en tienda",
}

/** La línea de cada parte que ve quien está, con lo guardado en ella. */
export function configLines(
  overview: ConfigOverview,
  store: Pick<MyStore, "name" | "country" | "timeZone" | "currency">,
): Partial<Record<ConfigSectionId, ConfigLine>> {
  const lines: Partial<Record<ConfigSectionId, ConfigLine>> = {}
  const city = (store.timeZone.split("/").at(-1) ?? store.timeZone).replaceAll("_", " ")
  lines.datos = {
    id: "datos",
    summary: [store.name, store.country ? countryName(store.country) : null, `hora de ${city}`]
      .filter(Boolean)
      .join(" · "),
    status: store.country ? "Listo" : "Falta el país",
    pending: !store.country,
  }
  const { brand } = overview
  lines.marca = {
    id: "marca",
    summary: [
      brand.publicName ?? store.name,
      brand.logo ? "con logo" : "sin logo",
      brand.link ? `link ${brand.link}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    status:
      brand.logo && brand.brandColor
        ? "Lista"
        : !brand.logo && !brand.brandColor
          ? "Sin logo ni color"
          : !brand.logo
            ? "Sin logo"
            : "Sin color",
    pending: !brand.logo || !brand.brandColor,
  }
  if (overview.sofi) {
    const skipped = overview.steps.some((s) => s.step === "sofi" && s.state === "saltado")
    lines.sofi = {
      id: "sofi",
      summary: overview.sofi.tried
        ? "Ya la probaste"
        : skipped
          ? "No la usas por ahora"
          : "Sin probar",
      status: overview.sofi.enabled ? "Encendida" : "Apagada",
      pending: !overview.sofi.tried && !skipped,
    }
  }
  const byCollection = (collection: PaymentCollection) =>
    overview.payments.filter((p) => p.collection === collection).map((p) => p.name)
  const capture = byCollection("comprobante")
  const onDelivery = byCollection("al_recibir")
  const paymentParts = [
    capture.length > 0 ? `${listText(capture)} con captura` : null,
    onDelivery.length > 0 ? `${listText(onDelivery)} al recibir` : null,
  ].filter(Boolean)
  lines.pagos = {
    id: "pagos",
    summary: paymentParts.length > 0 ? paymentParts.join(" · ") : "Sin medios de pago",
    status: overview.paymentLink
      ? `Con ${PROVIDER_NAMES[overview.paymentLink.provider]}`
      : "Sin pasarela",
    pending: overview.payments.length === 0 || !overview.paymentLink,
  }
  const zones = overview.deliveries.reduce((sum, d) => sum + d.zones, 0)
  const ownFleet = overview.deliveries.some((d) => d.type === "DeliveryModeOwnFleet")
  lines.entregas = {
    id: "entregas",
    summary:
      overview.deliveries.length > 0
        ? overview.deliveries
            .map((d, index) => {
              const name = DELIVERY_SHORT[d.type] ?? d.name
              return index === 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name
            })
            .join(" · ")
        : "Sin formas de entrega",
    status:
      overview.deliveries.length === 0
        ? "Falta"
        : zones > 0
          ? plural(zones, "zona", "zonas")
          : ownFleet
            ? "Sin zonas"
            : "Al día",
    pending: overview.deliveries.length === 0,
  }
  const { team } = overview
  lines.equipo = {
    id: "equipo",
    summary: [
      plural(team.members, "persona", "personas"),
      team.invitations > 0
        ? plural(team.invitations, "invitación por aceptar", "invitaciones por aceptar")
        : null,
      team.couriers.length > 0
        ? `${listText(team.couriers)} ${team.couriers.length === 1 ? "reparte" : "reparten"}`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
    status: team.supportAsks > 0 ? "Soporte pide mirar" : "Al día",
    pending: team.supportAsks > 0,
  }
  if (overview.plan) {
    const { plan } = overview
    const late =
      plan.status === "gracia" || plan.status === "restringida" || plan.status === "pausada"
    lines.plan = {
      id: "plan",
      summary: [
        plan.name ? `Plan ${plan.name}` : "Sin plan todavía",
        plan.creditLeftCents !== null && plan.currency
          ? `te quedan ${money(plan.creditLeftCents, plan.currency)} de crédito`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      status: plan.status ? STATUS_WORDS[plan.status] : "—",
      pending: late,
    }
  }
  return lines
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

/*
 * El buscador de Configuración (tablero 3): no es el de Ctrl+K. Encuentra cada parte por lo que
 * hay dentro, con las palabras de quien vende («yape», «shalom», «envío gratis»), y los nombres
 * que la tienda guardó (sus medios, sus formas de entrega, su equipo y sus repartidores). Cada
 * resultado dice dónde está y lleva ahí.
 */

export interface SearchEntry {
  /** Lo que se ve en el resultado. */
  text: string
  section: ConfigSectionId
  /** Las palabras con que se encuentra, además de las de `text`. */
  terms: readonly string[]
}

/** Lo que hay dentro de cada parte, con las palabras con que se busca. Solo lo que existe hoy. */
export const SEARCH_INDEX: readonly SearchEntry[] = [
  { text: "Nombre de la tienda", section: "datos", terms: ["nombre", "tienda"] },
  { text: "País de tu tienda", section: "datos", terms: ["país", "pais", "impuesto"] },
  {
    text: "Hora de la tienda",
    section: "datos",
    terms: ["hora", "horario", "zona horaria", "hoy", "mañana"],
  },
  { text: "Moneda", section: "datos", terms: ["moneda", "soles", "dólares"] },
  { text: "Logo y portada", section: "marca", terms: ["logo", "portada", "foto", "imagen"] },
  { text: "Color de tu marca", section: "marca", terms: ["color", "colores"] },
  {
    text: "Nombre que ve la clienta",
    section: "marca",
    terms: ["nombre", "marca", "cliente", "clienta"],
  },
  { text: "Tu link", section: "marca", terms: ["link", "enlace", "url", "dirección", "dominio"] },
  { text: "Encender o apagar a Sofi", section: "sofi", terms: ["sofi", "vendedora", "apagar"] },
  {
    text: "Lo que Sofi debe saber",
    section: "sofi",
    terms: ["horario", "cambios", "talla", "cuidados", "saber"],
  },
  { text: "Probar a Sofi", section: "sofi", terms: ["probar", "prueba", "conversación"] },
  {
    text: "Seguimientos de Argos",
    section: "sofi",
    terms: ["argos", "seguimiento", "recordar", "gracias", "recordatorio"],
  },
  {
    text: "Yape, Plin y transferencias",
    section: "pagos",
    terms: ["yape", "plin", "transferencia", "banco", "cuenta", "cci", "qr", "número"],
  },
  {
    text: "Cobrar por link de pago",
    section: "pagos",
    terms: ["link", "pasarela", "mercado pago", "tarjeta", "yape", "enlace"],
  },
  {
    text: "Quién confirma un pago con captura",
    section: "pagos",
    terms: ["captura", "comprobante", "voucher", "confirmar", "yape"],
  },
  {
    text: "Efectivo y pago al recibir",
    section: "pagos",
    terms: ["efectivo", "contraentrega", "al recibir", "puerta"],
  },
  {
    text: "Reparto propio y zonas",
    section: "entregas",
    terms: ["reparto", "delivery", "zona", "zonas", "distrito", "motorizado", "envío", "envio"],
  },
  { text: "Recojo en tienda", section: "entregas", terms: ["recojo", "recoger", "tienda"] },
  {
    text: "Envío por agencia",
    section: "entregas",
    terms: ["agencia", "shalom", "olva", "marvisur", "provincia", "envío", "envio"],
  },
  {
    text: "Envío gratis y descuento del envío",
    section: "entregas",
    terms: ["envío gratis", "envio gratis", "gratis", "descuento", "negociar"],
  },
  {
    text: "Pago al recibir por forma de entrega",
    section: "entregas",
    terms: ["contraentrega", "al recibir", "yape", "efectivo", "puerta"],
  },
  {
    text: "Franjas de entrega",
    section: "entregas",
    terms: ["franja", "horario", "hora de entrega", "turno"],
  },
  { text: "Invitar a tu equipo", section: "equipo", terms: ["invitar", "invitación", "correo"] },
  {
    text: "Roles y permisos",
    section: "equipo",
    terms: ["rol", "dueño", "administrador", "ventas", "permiso", "quitar"],
  },
  {
    text: "Repartidores",
    section: "equipo",
    terms: ["repartidor", "reparte", "motorizado", "delivery"],
  },
  {
    text: "Soporte de gestorIA",
    section: "equipo",
    terms: ["soporte", "mirar", "dejar entrar", "acceso"],
  },
  {
    text: "Avisos al celular",
    section: "avisos",
    terms: ["avisos", "notificaciones", "celular", "instalar", "push"],
  },
  { text: "Tu plan", section: "plan", terms: ["plan", "precio", "suscripción"] },
  {
    text: "Lo que se te cobró y tus pagos",
    section: "plan",
    terms: ["cobro", "factura", "comprobante", "pagar", "recibo"],
  },
  { text: "Gasto de este periodo", section: "plan", terms: ["saldo", "tope", "gasto", "crédito"] },
]

/** Los nombres que guardó la tienda, para encontrarlos también (sus medios, su equipo…). */
export function namesIndex(overview: ConfigOverview | undefined): SearchEntry[] {
  if (!overview) return []
  return [
    ...overview.payments.map((p) => ({ text: p.name, section: "pagos" as const, terms: [] })),
    ...overview.deliveries.map((d) => ({ text: d.name, section: "entregas" as const, terms: [] })),
    ...overview.team.couriers.map((name) => ({
      text: `${name} · repartidor`,
      section: "equipo" as const,
      terms: [name, "repartidor"],
    })),
    ...overview.team.names.map((name) => ({ text: name, section: "equipo" as const, terms: [] })),
  ]
}

/** Sin mayúsculas ni tildes: «Envío» y «envio» son lo mismo. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
}

export interface SearchResult {
  text: string
  section: ConfigSection
}

/**
 * Lo que coincide con lo escrito, en las partes que ve quien está: cada palabra escrita tiene que
 * empezar alguna palabra del resultado o de sus términos. Primero lo que se llama igual y lo que empieza igual; después,
 * el resto en el orden de Configuración. Sin repetir el mismo texto en la misma parte.
 */
export function searchConfig(
  query: string,
  store: Seat,
  entries: readonly SearchEntry[],
  limit = 8,
): SearchResult[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const scored: { entry: SearchEntry; score: number; order: number }[] = []
  entries.forEach((entry, order) => {
    const section = SECTIONS[entry.section]
    if (section.id === "integraciones" && !INTEGRATIONS_READY) return
    if (!seesSection(store, section)) return
    const text = fold(entry.text)
    const haystack = [text, ...entry.terms.map(fold), fold(section.label)].join(" ")
    const tokens = haystack.split(/[\s,·.()/]+/).filter(Boolean)
    const phrase = words.join(" ")
    const all = words.every((word) => tokens.some((token) => token.startsWith(word)))
    const inPhrase = haystack.includes(phrase)
    if (!all && !inPhrase) return
    const score =
      text === phrase
        ? 0
        : text.startsWith(phrase)
          ? 1
          : entry.terms.some((t) => fold(t) === phrase)
            ? 2
            : 3
    scored.push({ entry, score, order })
  })
  const seen = new Set<string>()
  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .filter(({ entry }) => {
      const key = `${entry.section}|${fold(entry.text)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map(({ entry }) => ({ text: entry.text, section: SECTIONS[entry.section] }))
}
