import {
  accountCopy,
  CUSTOMER_FACT_KEYS,
  type CustomerFactKey,
  type CustomerFactSource,
  conversation,
  customer,
  customerConsent,
  customerFact,
  type Db,
  product,
  saleOrder,
} from "@gestoria/db"
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm"
import { z } from "zod"
import { agentName } from "./agente.js"
import type { Person } from "./cuenta.js"
import { can, type StoreSeat } from "./permisos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * El perfil de la clienta (ADR 0240): lo que Argos sabe de ella, cada dato con de dónde salió y
 * cuándo, y cuándo se le puede escribir. Argos lo anota solo (`sofi/perfilar.ts`); la tienda lo
 * corrige con «Corregir», y lo que corrige queda «Lo puso la tienda»: Argos no lo vuelve a pisar
 * (la base se lo niega, `0051_reglas_perfil_de_la_clienta.sql`).
 *
 * - Nada se edita ni se borra: el historial de un dato son sus filas (`customer_fact`).
 * - El valor de hoy de cada dato: el último que puso la tienda, si puso alguno; si no, el último.
 * - Se lee la familia de la ficha (ella y las que una persona le unió, `merged_into`): unir no
 *   mueve datos. Nunca se une ni se busca por el teléfono.
 * - El permiso para escribirle lo anota Sofi con lo que dijo ella (`customer_consent`); aquí solo
 *   se lee el último, de su familia o, sin ficha, de sus conversaciones donde solo hay pedidos de
 *   ella (`lastConsentIn`).
 * - Argos y Sofi anotan en la ficha propia del pedido de cada conversación, no en la que se ve: así
 *   «Separar» se lleva lo suyo. «Corregir» anota en la que se ve.
 */

export type FactSource = CustomerFactSource
export type ProfileChannel = "whatsapp" | "instagram" | "messenger"
export const PROFILE_CHANNELS = ["whatsapp", "instagram", "messenger"] as const

export interface FactStep {
  value: string
  source: FactSource
  quote: string | null
  orderNumber: string | null
  /** null: lo anotó Argos. */
  byName: string | null
  at: string
}

export interface ProfileFact {
  key: CustomerFactKey
  /** «Talla» (o como llame la tienda a su medida), «Distrito», «Cumpleaños»… */
  label: string
  /** Para mostrar: «12 de marzo», «WhatsApp», «@andre.castillo». */
  value: string
  /** Como se guarda y se corrige: «--03-12», «whatsapp». */
  raw: string
  source: FactSource
  quote: string | null
  orderNumber: string | null
  at: string
  byName: string | null
  /**
   * Lo que Argos no tiene claro («Por confirmar»): cada posibilidad para mostrar (`value`) y como
   * se guarda (`raw`, lo que se manda a «Corregir» al elegirla). Vacío es que está claro.
   */
  alternatives: { value: string; raw: string }[]
  /** Del más nuevo al más viejo: todas las filas de ese dato en la familia. */
  history: FactStep[]
}

export type ConsentView = "si" | "no" | "baja" | "sin_preguntar"

export interface CustomerProfile {
  measureLabel: string
  facts: Partial<Record<CustomerFactKey, ProfileFact>>
  consent: {
    state: ConsentView
    quote: string | null
    at: string | null
    channel: ProfileChannel | null
  }
  /** Por dónde escribió (sin «Probar a Sofi»). */
  channels: ProfileChannel[]
  canCorrect: boolean
}

/** Sin catálogo con opciones, la medida se llama así. */
export const DEFAULT_MEASURE_LABEL = "Talla"

const FIXED_LABELS: Record<Exclude<CustomerFactKey, "medida">, string> = {
  distrito: "Distrito",
  cumpleanos: "Cumpleaños",
  canal: "Canal preferido",
  instagram: "Instagram",
  gustos: "Lo que le gusta",
}

const CHANNEL_NAMES: Record<ProfileChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
]

/** Los días de cada mes, con el 29 de febrero: el cumpleaños no lleva año. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const pad = (number: number) => String(number).padStart(4, "0")
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()

/* ------------------------------------------------------------------- la medida */

/**
 * Cómo llama la tienda a su medida: el nombre de opción más usado en su catálogo (Talla, Tono,
 * Medida…); si empatan, el que más veces va primero, y después el que apareció antes. Sin
 * productos con opciones, «Talla».
 */
export function measureLabelOf(products: { options: { name: string }[] }[]): string {
  const seen = new Map<string, { name: string; uses: number; first: number; order: number }>()
  let order = 0
  for (const p of products)
    for (const [i, option] of p.options.entries()) {
      const key = fold(option.name)
      if (!key) continue
      const row = seen.get(key) ?? { name: option.name.trim(), uses: 0, first: 0, order: order++ }
      row.uses += 1
      if (i === 0) row.first += 1
      seen.set(key, row)
    }
  const best = [...seen.values()].sort(
    (a, b) => b.uses - a.uses || b.first - a.first || a.order - b.order,
  )[0]
  return best?.name ?? DEFAULT_MEASURE_LABEL
}

export interface MeasureCatalog {
  label: string
  /** Los valores de esa opción en el catálogo, por su forma sin mayúsculas ni tildes. */
  values: Map<string, string>
  /** La posición de esa opción en cada producto (los que la tienen). */
  indexOf: Map<string, number>
}

/** La medida de la tienda y sus valores en el catálogo. */
export async function measureCatalogIn(tx: Db, storeId: string): Promise<MeasureCatalog> {
  const products = await tx
    .select({ id: product.id, options: product.options })
    .from(product)
    .where(eq(product.storeId, storeId))
    .orderBy(product.createdAt)
  const label = measureLabelOf(products)
  const values = new Map<string, string>()
  const indexOf = new Map<string, number>()
  for (const p of products) {
    const i = p.options.findIndex((option) => fold(option.name) === fold(label))
    if (i < 0) continue
    indexOf.set(p.id, i)
    for (const value of p.options[i]!.values) {
      const key = fold(value)
      if (key && !values.has(key)) values.set(key, value.trim())
    }
  }
  return { label, values, indexOf }
}

/* ------------------------------------------------------- cómo se lee cada dato */

/** «--03-12» → «12 de marzo»; si no es una fecha, tal cual. */
export function birthdayText(raw: string): string {
  const match = /^--(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return raw
  return `${Number(match[2])} de ${MONTHS[Number(match[1]) - 1] ?? ""}`.trim()
}

/** Si «--MM-DD» es un día del calendario (el 29 de febrero también). */
export function isBirthday(raw: string): boolean {
  const match = /^--(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return false
  const month = Number(match[1])
  const day = Number(match[2])
  return month >= 1 && month <= 12 && day >= 1 && day <= MONTH_DAYS[month - 1]!
}

/** Lo guardado de un dato, como se lee en la ficha. */
export function factText(key: CustomerFactKey, raw: string): string {
  if (key === "cumpleanos") return birthdayText(raw)
  if (key === "canal") return CHANNEL_NAMES[raw as ProfileChannel] ?? raw
  return raw
}

/** El usuario de Instagram como se guarda («@handle»), o null si no lo es. */
export function instagramHandle(text: string): string | null {
  const handle = text.trim().replace(/^@/, "")
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? `@${handle.toLowerCase()}` : null
}

/** Un texto corto de la clienta (medida, distrito, gustos), sin espacios de más. */
function shortText(text: string): string | null {
  const value = text.trim().replace(/\s+/g, " ")
  return value.length >= 1 && value.length <= 120 ? value : null
}

/**
 * Lo que se guarda de un dato, comprobado: null si no vale. La medida, aquí, es texto: la tienda
 * puede corregirla aunque no esté en su catálogo (Argos sí la compara con él).
 */
export function factValue(key: CustomerFactKey, value: string): string | null {
  switch (key) {
    case "cumpleanos":
      return isBirthday(value.trim()) ? value.trim() : null
    case "canal":
      return (PROFILE_CHANNELS as readonly string[]).includes(value.trim()) ? value.trim() : null
    case "instagram":
      return instagramHandle(value)
    default:
      return shortText(value)
  }
}

const FACT_ERRORS: Record<CustomerFactKey, string> = {
  medida: "Escribe la medida (hasta 120 caracteres)",
  distrito: "Escribe el distrito (hasta 120 caracteres)",
  cumpleanos: "Elige un día y un mes que existan",
  canal: "Elige WhatsApp, Instagram o Messenger",
  instagram: "Escribe su usuario de Instagram: letras, números, punto o guion bajo, hasta 30",
  gustos: "Escribe lo que le gusta (hasta 120 caracteres)",
}

export const factInput = z.object({
  key: z.enum(CUSTOMER_FACT_KEYS, "Ese dato no existe"),
  // Cada dato tiene su propio tope (`factValue`); esto solo corta lo que no puede ser un dato.
  value: z.string("Escribe el dato").max(300, "Es demasiado largo"),
})

/* --------------------------------------------------------------- la familia */

/** La ficha que se ve y las que una persona le unió: sus ids, la que se ve primero. */
export async function familyIn(tx: Db, storeId: string, rootId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(
      and(
        eq(customer.storeId, storeId),
        or(eq(customer.id, rootId), eq(customer.mergedInto, rootId)),
      ),
    )
  return [rootId, ...rows.map((r) => r.id).filter((id) => id !== rootId)]
}

/** Las conversaciones de verdad de la familia: las de sus pedidos (nunca por el teléfono). */
export async function familyConversationsIn(tx: Db, storeId: string, family: string[]) {
  if (family.length === 0) return []
  return tx
    .selectDistinct({ id: conversation.id, channel: conversation.channel })
    .from(saleOrder)
    .innerJoin(conversation, eq(conversation.id, saleOrder.conversationId))
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        inArray(saleOrder.customerId, family),
        isNotNull(saleOrder.conversationId),
        ne(conversation.channel, "prueba"),
      ),
    )
}

/**
 * Las conversaciones donde quien escribe es ella: todos sus pedidos con ficha son de la familia.
 * Si un chat tiene pedidos de otra familia, quien escribe puede ser otra persona (interlocutora ≠
 * clienta): lo de ese chat sin ficha no se le cuenta a ninguna.
 */
export async function ownConversationsIn(
  tx: Db,
  storeId: string,
  family: string[],
): Promise<string[]> {
  if (family.length === 0) return []
  const rows = await tx
    .select({ id: saleOrder.conversationId })
    .from(saleOrder)
    .innerJoin(customer, eq(customer.id, saleOrder.customerId))
    .where(and(eq(saleOrder.storeId, storeId), isNotNull(saleOrder.conversationId)))
    .groupBy(saleOrder.conversationId)
    .having(sql`bool_and(${inArray(customer.id, family)})`)
  return rows.flatMap((r) => (r.id ? [r.id] : []))
}

/**
 * El último permiso o baja de la familia: lo anotado en sus fichas y, sin ficha, lo de sus
 * conversaciones donde quien escribe es ella (`ownConversationsIn`); más, si se pide, lo de una
 * conversación (la que atiende Sofi). Sin nada, null: ante la duda, no se le escribe.
 */
export async function lastConsentIn(
  tx: Db,
  storeId: string,
  family: string[],
  options: { conversationId?: string; skipTest?: boolean } = {},
) {
  const own = await ownConversationsIn(tx, storeId, family)
  const reach = [
    ...(family.length ? [inArray(customerConsent.customerId, family)] : []),
    ...(own.length
      ? [and(isNull(customerConsent.customerId), inArray(customerConsent.conversationId, own))]
      : []),
    ...(options.conversationId ? [eq(customerConsent.conversationId, options.conversationId)] : []),
  ]
  if (reach.length === 0) return null
  const [last] = await tx
    .select({
      state: customerConsent.state,
      quote: customerConsent.quote,
      at: customerConsent.createdAt,
      channel: customerConsent.channel,
    })
    .from(customerConsent)
    .where(
      and(
        eq(customerConsent.storeId, storeId),
        options.skipTest ? ne(customerConsent.channel, "prueba") : undefined,
        or(...reach),
      ),
    )
    .orderBy(desc(customerConsent.createdAt))
    .limit(1)
  return last ?? null
}

export interface FactRow {
  id: string
  key: CustomerFactKey
  value: string
  source: FactSource
  quote: string | null
  orderId: string | null
  orderNumber: number | null
  alternatives: string[]
  actorUserId: string
  actorName: string | null
  createdAt: Date
}

/** Todas las filas de los datos de la familia, de la más nueva a la más vieja. */
export async function factRowsIn(tx: Db, storeId: string, family: string[]): Promise<FactRow[]> {
  if (family.length === 0) return []
  return tx
    .select({
      id: customerFact.id,
      key: customerFact.key,
      value: customerFact.value,
      source: customerFact.source,
      quote: customerFact.quote,
      orderId: customerFact.orderId,
      orderNumber: saleOrder.number,
      alternatives: customerFact.alternatives,
      actorUserId: customerFact.actorUserId,
      actorName: accountCopy.name,
      createdAt: customerFact.createdAt,
    })
    .from(customerFact)
    .leftJoin(saleOrder, eq(saleOrder.id, customerFact.orderId))
    .leftJoin(accountCopy, eq(accountCopy.userId, customerFact.actorUserId))
    .where(and(eq(customerFact.storeId, storeId), inArray(customerFact.customerId, family)))
    .orderBy(desc(customerFact.createdAt), desc(customerFact.id))
}

/** El valor de hoy de un dato: el último de la tienda, si puso alguno; si no, el último. */
export function currentOf(rows: FactRow[], key: CustomerFactKey): FactRow | null {
  const mine = rows.filter((r) => r.key === key)
  return mine.find((r) => r.source === "tienda") ?? mine[0] ?? null
}

/** Quién lo anotó, para la ficha: null es Argos; alguien del equipo, con su nombre. */
function byNameOf(row: FactRow): string | null {
  if (agentName(row.actorUserId)) return null
  return row.actorName ?? "Alguien del equipo"
}

/* --------------------------------------------------------------- el perfil */

/**
 * El perfil de una clienta para su ficha. `rootId` es la ficha que se ve; `seat`, el lugar de
 * quien lo mira (para «Corregir»).
 */
export async function customerProfileIn(
  tx: Db,
  storeId: string,
  rootId: string,
  seat: StoreSeat,
): Promise<CustomerProfile> {
  const family = await familyIn(tx, storeId, rootId)
  const { label: measureLabel } = await measureCatalogIn(tx, storeId)
  const rows = await factRowsIn(tx, storeId, family)
  const facts: Partial<Record<CustomerFactKey, ProfileFact>> = {}
  for (const key of CUSTOMER_FACT_KEYS) {
    const now = currentOf(rows, key)
    if (!now) continue
    facts[key] = {
      key,
      label: key === "medida" ? measureLabel : FIXED_LABELS[key],
      value: factText(key, now.value),
      raw: now.value,
      source: now.source,
      quote: now.quote,
      orderNumber: now.orderNumber === null ? null : pad(now.orderNumber),
      at: now.createdAt.toISOString(),
      byName: byNameOf(now),
      // Lo que corrigió la tienda está claro.
      alternatives:
        now.source === "tienda"
          ? []
          : now.alternatives.map((raw) => ({ value: factText(key, raw), raw })),
      history: rows
        .filter((r) => r.key === key)
        .map((r) => ({
          value: factText(key, r.value),
          source: r.source,
          quote: r.quote,
          orderNumber: r.orderNumber === null ? null : pad(r.orderNumber),
          byName: byNameOf(r),
          at: r.createdAt.toISOString(),
        })),
    }
  }
  const conversations = await familyConversationsIn(tx, storeId, family)
  const consent = await lastConsentIn(tx, storeId, family, { skipTest: true })
  const channels = PROFILE_CHANNELS.filter((channel) =>
    conversations.some((c) => c.channel === channel),
  )
  return {
    measureLabel,
    facts,
    consent: consent
      ? {
          state: consent.state,
          quote: consent.quote,
          at: consent.at.toISOString(),
          channel: consent.channel === "prueba" ? null : consent.channel,
        }
      : { state: "sin_preguntar", quote: null, at: null, channel: null },
    channels,
    canCorrect: can(seat, "ventas.atender"),
  }
}

/* ---------------------------------------------------------------- «Corregir» */

/**
 * «Corregir» un dato: queda «Lo puso la tienda», a nombre de quien lo corrigió, en la ficha que se
 * ve. Si ya es ese y ya lo puso la tienda, no suma otra fila. Devuelve el perfil como queda.
 */
export async function correctFactIn(
  tx: Db,
  storeId: string,
  rootId: string,
  actorUserId: string,
  input: z.infer<typeof factInput>,
  seat: StoreSeat,
): Promise<CustomerProfile> {
  const value = factValue(input.key, input.value)
  if (!value)
    throw new StoreError(400, "VALIDATION_ERROR", FACT_ERRORS[input.key], {
      value: FACT_ERRORS[input.key],
    })
  const family = await familyIn(tx, storeId, rootId)
  const now = currentOf(await factRowsIn(tx, storeId, family), input.key)
  if (!(now?.source === "tienda" && now.value === value))
    await tx.insert(customerFact).values({
      storeId,
      customerId: rootId,
      key: input.key,
      value,
      source: "tienda",
      actorUserId,
    })
  return customerProfileIn(tx, storeId, rootId, seat)
}

/** La ficha que se ve de una clienta, o 404. */
async function shownRootIn(tx: Db, storeId: string, customerId: string): Promise<string> {
  const [row] = await tx
    .select({ id: customer.id, mergedInto: customer.mergedInto })
    .from(customer)
    .where(and(eq(customer.id, customerId), eq(customer.storeId, storeId)))
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa clienta ya no está")
  return row.mergedInto ?? row.id
}

/** `POST /api/tiendas/:id/clientes/:customerId/datos`: lo que atiende la tienda corrige. */
export async function correctFact(
  appDb: Db,
  person: Person,
  storeId: string,
  customerId: string,
  input: z.infer<typeof factInput>,
) {
  if (!z.uuid().safeParse(customerId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa clienta ya no está")
  return inStore(appDb, person, storeId, "ventas.atender", async (tx, seat) => {
    const root = await shownRootIn(tx, storeId, customerId)
    return { profile: await correctFactIn(tx, storeId, root, person.userId, input, seat) }
  })
}
