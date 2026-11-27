import {
  conversation,
  type Db,
  type OrderChannel,
  orderPayment,
  product,
  productLink,
  productVariant,
  saleOrder,
  stockRequest,
  storePaymentLink,
  storePaymentMethod,
} from "@gestoria/db"
import { and, asc, eq, inArray, or } from "drizzle-orm"
import { z } from "zod"
import { countConversation } from "../acuerdo.js"
import { SOFI_ACTOR, withAgent } from "../agente.js"
import { COLLECTION_RANK } from "../configuracion.js"
import { fractionDigits, formatMoney as intlMoney } from "../dinero.js"
import { momentWords } from "../hora.js"
import {
  addReceiptIn,
  cancelOrderIn,
  createOrderIn,
  createPaymentLinkWith,
  type LinkDeps,
  type OrderInput,
  orderInput,
  pad,
  quoteOrderIn,
  variantPrices,
} from "../pedidos.js"
import { autoUnitCents, floorOf } from "../precio.js"
import { type Balance, balanceIn, balancesIn } from "../saldo.js"
import { StoreError } from "../tiendas.js"
import type { ToolDef } from "./modelo.js"
import { percentsIn } from "./revisar.js"

/**
 * Las herramientas de Sofi (paso B5, tablero 8). Cada una llama a la misma operación de negocio
 * que usa el equipo (`pedidos.ts`): el precio, el mínimo, el margen, el stock y los estados son
 * las reglas de siempre, no se repiten aquí. Lo único propio de Sofi:
 *
 * - Solo ve y toca los pedidos de su conversación.
 * - Arma un pedido solo con un resumen que el cliente ya vio: la misma cotización tuvo que salir
 *   en una respuesta anterior y el cliente tuvo que escribir después.
 * - Nunca confirma un pago: anota la captura y queda por confirmar (la base tampoco la deja).
 * - Su oferta (lienzo «gestorIA como odentIA», tablero 21): una sola por conversación, sin
 *   mejorarla si la clienta insiste, siempre a cambio de pagar en el plazo que le dijo y nunca con
 *   pago al recibir (`offerProblem`). Vencido el plazo, no la renueva sola.
 *
 * Lo que devuelven es JSON en palabras del cliente, con los importes ya escritos en la moneda de
 * la tienda: el modelo los repite tal cual. Cada importe y porcentaje que muestran queda anotado
 * para la comprobación antes de enviar (`revisar.ts`).
 */

/** Un importe como lo escribe Sofi («S/ 129»), con espacio común: así lo copia el modelo tal cual. */
export function moneyText(cents: number, currency: string): string {
  return intlMoney(cents, currency).replace(/ /g, " ")
}
const formatMoney = moneyText

export interface TurnTrace {
  /** Las herramientas que corrieron, en orden, y cómo terminaron. */
  tools: { name: string; ok: boolean; code?: string }[]
  /** Los importes (en la unidad menor) y porcentajes que Sofi vio en este turno. */
  amounts: Set<number>
  percents: Set<number>
  /** Las cotizaciones de este turno: su clave y su total. Van en la respuesta como «mostradas». */
  quotes: Map<string, number>
  /** Pasó la conversación a una persona, con este motivo. */
  handoff: string | null
  /** Las cotizaciones negociadas de este turno: su total y lo que cede. De ahí sale la oferta. */
  offers: { totalCents: number; cededCents: number }[]
}

export function newTrace(): TurnTrace {
  return {
    tools: [],
    amounts: new Set(),
    percents: new Set(),
    quotes: new Map(),
    handoff: null,
    offers: [],
  }
}

/**
 * Lo que de verdad le ofreció en este turno, o null si no negoció. Sofi prueba opciones con
 * cotizar antes de decirlas: cuenta lo más que cede una cotización cuyo total salió en su
 * respuesta. Si no escribió ningún total (dijo «S/ 10 menos» sin el total), cuenta la que menos
 * cede: así una prueba que no dijo no le deja mejorar la oferta después.
 */
export function offeredIn(trace: Pick<TurnTrace, "offers">, said: number[]): number | null {
  if (trace.offers.length === 0) return null
  const shown = trace.offers.filter((o) => said.includes(o.totalCents))
  return shown.length
    ? Math.max(...shown.map((o) => o.cededCents))
    : Math.min(...trace.offers.map((o) => o.cededCents))
}

/**
 * La oferta que Sofi ya le hizo en esta conversación, desde su última compra: lo más que cedió y
 * hasta cuándo vale (la hora que le dijo). Sale de sus respuestas anteriores (`detail.oferta`).
 */
export interface SofiOffer {
  cededCents: number
  expiresAt: Date
}

/**
 * Por qué una cotización negociada no se puede ofrecer, o null si se puede. Es lo propio de Sofi
 * al vender (tablero 21), no una regla del precio: el equipo sigue negociando como siempre.
 *
 * - Con pago al recibir no hay rebaja: es a cambio de pagar ya.
 * - Vencido el plazo que le dijo, la oferta no se renueva sola.
 * - Ofrece una sola vez: si la clienta insiste, no cede más que lo que ya le ofreció.
 */
export function offerProblem(
  offer: SofiOffer | null,
  now: Date,
  priced: { negotiated: boolean; marginUsedCents: number },
  collection: string | null,
): string | null {
  if (!priced.negotiated) return null
  if (collection === "al_recibir")
    return "Con pago al recibir no hay rebaja: es a cambio de pagar ya. Cotiza a su precio normal, o que pague con link o captura para mantener lo que le ofreciste."
  if (offer && offer.expiresAt.getTime() <= now.getTime())
    return "Lo que le ofreciste ya venció y no se renueva: cotiza a su precio normal."
  if (offer && priced.marginUsedCents > offer.cededCents)
    return "Ya le hiciste tu oferta en esta conversación y no se mejora: repite la misma, o dale a elegir otra que ceda lo mismo o menos."
  return null
}

export interface SofiToolContext {
  appDb: Db
  storeId: string
  conversationId: string
  /** La conversación de prueba: sus pedidos son de prueba. */
  test: boolean
  channel: OrderChannel
  currency: string
  today: string
  link: LinkDeps
  /** Las cotizaciones que el cliente ya vio en respuestas anteriores (y escribió después). */
  shownQuotes: Set<string>
  /** La hora de la tienda, para decir el plazo de la oferta. */
  timeZone: string
  now: Date
  /** La oferta que ya le hizo en esta conversación; null si todavía no le ofreció nada. */
  offer: SofiOffer | null
  /** Hasta cuándo vale lo que ofrezca ahora: el plazo de su oferta, o 24 horas desde ahora. */
  offerDeadline: Date
  trace: TurnTrace
}

/* ------------------------------------------------------------------------ los esquemas */

const amount = z
  .number()
  .min(0)
  .max(10_000_000)
  .describe("En la moneda de la tienda, como lo dirías: 120 o 89.90")

const lineSchema = z.object({
  variante_id: z.string().describe("El variante_id que devolvió buscar_productos"),
  cantidad: z.number().int().min(1).max(100),
  precio_unitario: amount
    .optional()
    .describe("Solo si negocias: el precio por unidad que ofreces. Sin él, el de la tienda"),
  regalo: z.boolean().optional().describe("Va de regalo (sale del mismo margen)"),
})

const quoteSchema = z.object({
  lineas: z.array(lineSchema).min(1).max(10),
  entrega_id: z.string().describe("El id de la forma de entrega elegida"),
  zona: z.string().optional().describe("Con envío por zona: el nombre exacto de la zona"),
  costo_envio: amount
    .optional()
    .describe("Con envío «se acuerda en el chat»: cuánto cuesta el envío"),
  envio_cobrado: amount
    .optional()
    .describe("Solo si negocias el envío: lo que paga el cliente de envío (0 = gratis)"),
  pago_id: z.string().optional().describe("El id del medio de pago; sin él, el primero"),
})

const orderSchema = quoteSchema.extend({
  nombre: z.string().min(1).max(120).describe("El nombre del cliente"),
  telefono: z.string().max(30).optional(),
  direccion: z.string().max(300).optional().describe("La dirección de entrega, si se envía"),
  notas: z.string().max(300).optional(),
})

const SCHEMAS = {
  buscar_productos: z.object({
    texto: z.string().min(1).max(200).describe("Lo que busca el cliente, en sus palabras"),
  }),
  cotizar: quoteSchema,
  armar_pedido: orderSchema,
  link_de_pago: z.object({ pedido: z.string().describe("El número del pedido, como «0143»") }),
  anotar_pago: z.object({
    pedido: z.string(),
    monto: amount.describe("El monto que se ve en la captura"),
    operacion: z.string().max(60).optional().describe("El número de operación de la captura"),
  }),
  ver_pedidos: z.object({}),
  avisar_cuando_vuelva: z.object({ variante_id: z.string() }),
  pasar_a_persona: z.object({
    motivo: z.string().trim().min(3).max(200).describe("Por qué, en una frase para el equipo"),
  }),
} as const

export type SofiToolName = keyof typeof SCHEMAS

const DESCRIPTIONS: Record<SofiToolName, string> = {
  buscar_productos:
    "Busca en el catálogo de la tienda: productos con su precio, sus variantes con stock, si se negocia, y lo parecido y lo que combina. Úsala antes de hablar de cualquier producto o precio.",
  cotizar:
    "Calcula el total de una compra con las reglas de la tienda: precio, promoción o precio por cantidad, envío y lo que negocies. Si pides algo bajo el mínimo, más de lo que se puede ceder o más de lo que ya ofreciste, te dice que no. Con un precio negociado te da el plazo exacto para pagarlo. Úsala antes de dar un total o una oferta.",
  armar_pedido:
    "Anota el pedido cuando el cliente confirmó el resumen. Necesita la misma cotización que ya le mostraste. El precio negociado vale hasta la hora que le dijiste.",
  link_de_pago:
    "Crea el link de pago del pedido (primera forma de cobro). Si la tienda no tiene link, te lo dice.",
  anotar_pago:
    "Anota la captura de un pago (Yape o transferencia) con el monto y el número de operación. Queda por confirmar: una persona del equipo lo revisa. Nunca lo das por pagado.",
  ver_pedidos: "Los pedidos de esta conversación, con su estado y su total.",
  avisar_cuando_vuelva:
    "Anota que el cliente quiere que le avises cuando vuelva una variante agotada.",
  pasar_a_persona:
    "Pasa la conversación a una persona del equipo: cuando no sabes, hay un reclamo, una devolución o un cambio, o el cliente lo pide.",
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

export const SOFI_TOOLS: ToolDef[] = (Object.keys(SCHEMAS) as SofiToolName[]).map((name) => ({
  type: "function",
  function: { name, description: DESCRIPTIONS[name], parameters: jsonSchema(SCHEMAS[name]) },
}))

/* ---------------------------------------------------------------------- utilidades */

const STOP = new Set([
  "hola",
  "tienen",
  "tienes",
  "quiero",
  "busco",
  "para",
  "cuanto",
  "cuesta",
  "precio",
  "talla",
  "tallas",
  "color",
  "colores",
  "una",
  "uno",
  "unos",
  "unas",
  "los",
  "las",
  "del",
  "que",
  "con",
  "hay",
  "por",
  "favor",
  "algo",
])

export function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

function wordsOf(text: string): string[] {
  return [...new Set(plain(text).match(/[a-z0-9]+/g) ?? [])].filter(
    (w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w),
  )
}

function centsOf(value: number | undefined, currency: string): number | null {
  if (value === undefined) return null
  return Math.round(value * 10 ** fractionDigits(currency))
}

class ToolProblem extends Error {
  constructor(
    message: string,
    public readonly code = "NO_SE_PUEDE",
  ) {
    super(message)
  }
}

/** La clave de una cotización: lo que cambia el precio, en orden. El medio de pago no. */
export function quoteKey(input: OrderInput, totalCents: number): string {
  return JSON.stringify([
    input.lines.map((l) => [l.variantId, l.quantity, l.unitCents, l.gift]),
    input.deliveryMethodId,
    input.zone,
    input.deliveryListCents,
    input.deliveryCents,
    totalCents,
  ])
}

const FIELD_WORDS: Record<string, string> = {
  deliveryMethodId: "La forma de entrega",
  paymentMethodId: "El medio de pago",
  zone: "La zona",
  deliveryListCents: "El costo del envío",
  deliveryCents: "El envío",
  lines: "El pedido",
}

function problemsOf(fields: Record<string, string>, input: OrderInput): string[] {
  return Object.entries(fields).map(([key, message]) => {
    const line = /^lines\.(\d+)\./.exec(key)
    if (line)
      return `Línea ${Number(line[1]) + 1} (${input.lines[Number(line[1])]?.variantId}): ${message}`
    return `${FIELD_WORDS[key] ?? key}: ${message}`
  })
}

/* ------------------------------------------------------------------------ las acciones */

async function paymentMethodFor(tx: Db, storeId: string, wanted: string | undefined) {
  const methods = await tx
    .select()
    .from(storePaymentMethod)
    .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.isActive, true)))
    .orderBy(asc(storePaymentMethod.createdAt))
  if (wanted) return methods.find((m) => m.id === wanted)?.id ?? wanted
  const [linked] = await tx
    .select({ provider: storePaymentLink.provider })
    .from(storePaymentLink)
    .where(eq(storePaymentLink.storeId, storeId))
  // En el orden de cobro de la tienda; un link sin cuenta conectada no se ofrece.
  const first = methods
    .filter((m) => m.collection !== "link" || Boolean(linked))
    .sort((a, b) => COLLECTION_RANK[a.collection] - COLLECTION_RANK[b.collection])[0]
  if (!first)
    throw new ToolProblem("La tienda no tiene medios de pago encendidos: pásalo a una persona")
  return first.id
}

/** Cómo se cobra un medio de pago de la tienda (link, captura o al recibir). */
async function collectionOf(tx: Db, storeId: string, paymentMethodId: string) {
  const [method] = await tx
    .select({ collection: storePaymentMethod.collection })
    .from(storePaymentMethod)
    .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.id, paymentMethodId)))
  return method?.collection ?? null
}

async function toOrderInput(
  tx: Db,
  ctx: SofiToolContext,
  args: z.infer<typeof quoteSchema>,
  customer: { nombre?: string; telefono?: string; direccion?: string; notas?: string } = {},
): Promise<OrderInput> {
  const parsed = orderInput.safeParse({
    customerName: customer.nombre ?? "Cliente",
    customerPhone: customer.telefono ?? "",
    channel: ctx.channel,
    address: customer.direccion ?? "",
    notes: customer.notas ?? "",
    lines: args.lineas.map((line) => ({
      variantId: line.variante_id,
      quantity: line.cantidad,
      unitCents: centsOf(line.precio_unitario, ctx.currency),
      gift: line.regalo ?? false,
    })),
    deliveryMethodId: args.entrega_id,
    zone: args.zona ?? null,
    deliveryListCents: centsOf(args.costo_envio, ctx.currency),
    deliveryCents: centsOf(args.envio_cobrado, ctx.currency),
    paymentMethodId: await paymentMethodFor(tx, ctx.storeId, args.pago_id),
  })
  if (!parsed.success)
    throw new ToolProblem(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      "DATOS",
    )
  return parsed.data
}

/** Los pedidos de esta conversación (y solo de ella). */
async function conversationOrders(tx: Db, ctx: SofiToolContext) {
  return tx
    .select()
    .from(saleOrder)
    .where(
      and(eq(saleOrder.storeId, ctx.storeId), eq(saleOrder.conversationId, ctx.conversationId)),
    )
    .orderBy(asc(saleOrder.number))
}

async function orderOf(tx: Db, ctx: SofiToolContext, pedido: string) {
  const number = Number.parseInt(pedido.replace(/\D/g, ""), 10)
  const found = (await conversationOrders(tx, ctx)).find((o) => o.number === number)
  if (!found) throw new ToolProblem(`El pedido ${pedido} no es de esta conversación`, "NO_ES_SUYO")
  return found
}

/**
 * El estado de un pedido como lo lee Sofi. Uno que se paga al recibir empieza «por salir» sin
 * pago: nunca se dice pagado. Con su saldo (`saldo.ts`), «pagado» solo si no falta nada y todo
 * está confirmado; si pagó una parte, que falta el resto (la misma regla que `stateName` de la
 * pantalla).
 */
export function stateWords(
  order: { state: string; paymentCollection: string },
  balance?: Balance,
): string {
  const nothingYet = !balance || balance.confirmedCents + balance.pendingCents === 0
  const onDelivery = order.paymentCollection === "al_recibir" && nothingYet
  const owes = balance ? balance.dueCents > 0 : onDelivery
  const words: Record<string, string> = {
    por_pagar: "por pagar",
    por_confirmar: "pago por confirmar: una persona del equipo lo está revisando",
    por_salir: onDelivery
      ? "por salir; se paga al recibir (todavía no pagó)"
      : !balance || balance.paid
        ? "pagado, por salir"
        : owes
          ? "por salir; pagó una parte y falta pagar el resto"
          : "por salir; un pago espera que una persona del equipo lo confirme",
    en_camino: onDelivery
      ? "en camino; se paga al recibir"
      : owes
        ? "en camino; falta pagar una parte"
        : "en camino",
    entregado: balance && balance.dueCents > 0 ? "entregado; falta pagar una parte" : "entregado",
    anulado: "anulado",
  }
  return words[order.state] ?? order.state
}

async function search(ctx: SofiToolContext, args: z.infer<typeof SCHEMAS.buscar_productos>) {
  return withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, async (tx) => {
    const variants = await variantPrices(tx, ctx.storeId, ctx.today)
    const productIds = [...new Set(variants.map((v) => v.productId))]
    if (productIds.length === 0) return { productos: [], nota: "La tienda no tiene productos" }
    const products = await tx
      .select({
        id: product.id,
        name: product.name,
        category: product.category,
        description: product.description,
      })
      .from(product)
      .where(inArray(product.id, productIds))
    const byProduct = Map.groupBy(variants, (v) => v.productId)
    const words = wordsOf(args.texto)
    const scored = products
      .map((p) => {
        const hay = plain(
          [
            p.name,
            p.category ?? "",
            p.description,
            ...(byProduct.get(p.id) ?? []).map((v) => v.variantName),
          ].join(" "),
        )
        const score = words.filter((w) => hay.includes(w)).length
        return { p, score }
      })
      .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    const matched = scored.filter((s) => s.score > 0)
    const chosen = (matched.length > 0 ? matched : scored).slice(0, 6).map((s) => s.p)
    const links = await tx
      .select({ a: productLink.productA, b: productLink.productB, kind: productLink.kind })
      .from(productLink)
      .where(
        or(
          inArray(
            productLink.productA,
            chosen.map((p) => p.id),
          ),
          inArray(
            productLink.productB,
            chosen.map((p) => p.id),
          ),
        ),
      )
    const nameOf = new Map(products.map((p) => [p.id, p.name]))
    const money = (cents: number) => {
      ctx.trace.amounts.add(cents)
      return formatMoney(cents, ctx.currency)
    }
    const fromPrice = (id: string) => {
      const own = byProduct.get(id) ?? []
      const inStock = own.filter((v) => v.stock > 0 || v.sellsWithoutStock)
      const prices = (inStock.length ? inStock : own).map((v) => autoUnitCents(v.pricing, 1))
      if (prices.length === 0) return null
      const low = Math.min(...prices)
      return { low, varies: prices.some((p) => p !== low), inStock: inStock.length > 0 }
    }
    const related = (id: string, kind: "parecido" | "combina") =>
      links
        .filter((l) => l.kind === kind && (l.a === id || l.b === id))
        .map((l) => (l.a === id ? l.b : l.a))
        .map((other) => ({ other, price: fromPrice(other) }))
        // Nunca algo sin stock (tablero 8).
        .filter((r) => r.price?.inStock && nameOf.has(r.other))
        .map((r) => ({
          producto_id: r.other,
          nombre: nameOf.get(r.other)!,
          precio: `${r.price!.varies ? "desde " : ""}${money(r.price!.low)}`,
        }))
    return {
      productos: chosen.map((p) => {
        const own = byProduct.get(p.id) ?? []
        const first = own[0]!
        const price = fromPrice(p.id)!
        // La promoción puede ser de un color o de una talla: cuenta la de cada variante.
        for (const v of own) if (v.pricing.percentOff) ctx.trace.percents.add(v.pricing.percentOff)
        const promoted = own.filter((v) => v.promotion)
        const wholeProduct =
          promoted.length === own.length && new Set(promoted.map((v) => v.promotion)).size === 1
        // Lo que dice la descripción («100 % cuero») también se puede repetir.
        for (const percent of percentsIn(p.description)) ctx.trace.percents.add(percent)
        return {
          producto_id: p.id,
          nombre: p.name,
          categoria: p.category,
          descripcion: p.description.slice(0, 400),
          precio: `${price.varies ? "desde " : ""}${money(price.low)}`,
          ...(wholeProduct
            ? { promocion: `${first.promotion} (${first.pricing.percentOff} % menos, ya incluido)` }
            : {}),
          ...(first.pricing.quantityPrices.length
            ? {
                precio_por_cantidad: first.pricing.quantityPrices.map(
                  (q) =>
                    `desde ${q.minQuantity}: ${money(q.unitPriceCents)} cada uno (${q.minQuantity} a ${money(q.unitPriceCents * q.minQuantity)})`,
                ),
              }
            : {}),
          // En liquidación o sin mínimo no se negocia (la misma regla del precio).
          se_negocia: own.some((v) => {
            const auto = autoUnitCents(v.pricing, 1)
            return floorOf(v.pricing, auto) < auto
          }),
          variantes: own.map((v) => {
            const unit = autoUnitCents(v.pricing, 1)
            if (v.pricing.listUnitCents !== unit) money(v.pricing.listUnitCents)
            return {
              variante_id: v.id,
              opciones: v.variantName,
              precio: money(unit),
              stock: v.stock,
              ...(v.stock === 0 && !v.sellsWithoutStock ? { agotada: true } : {}),
              ...(v.promotion && !wholeProduct
                ? { promocion: `${v.promotion} (${v.pricing.percentOff} % menos, ya incluido)` }
                : {}),
            }
          }),
          parecido: related(p.id, "parecido"),
          combina: related(p.id, "combina"),
        }
      }),
      ...(matched.length === 0
        ? { nota: "Nada coincide con lo que pidió: estos son otros productos de la tienda" }
        : {}),
    }
  })
}

async function quote(ctx: SofiToolContext, args: z.infer<typeof quoteSchema>) {
  return withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, async (tx) => {
    const input = await toOrderInput(tx, ctx, args)
    const result = await quoteOrderIn(tx, ctx.storeId, input, ctx.today, { byAgent: true })
    if (!result.quote) return { ok: false, problemas: problemsOf(result.fields, input) }
    const q = result.quote
    const problem = offerProblem(
      ctx.offer,
      ctx.now,
      q,
      await collectionOf(tx, ctx.storeId, input.paymentMethodId),
    )
    if (problem) return { ok: false, problemas: [problem] }
    if (q.negotiated)
      ctx.trace.offers.push({ totalCents: q.totalCents, cededCents: q.marginUsedCents })
    const money = (cents: number) => {
      ctx.trace.amounts.add(cents)
      return formatMoney(cents, ctx.currency)
    }
    ctx.trace.quotes.set(quoteKey(input, q.totalCents), q.totalCents)
    const absorbed = q.deliveryFreeByPolicy ? 0 : q.deliveryListCents - q.deliveryCents
    return {
      ok: true,
      total: money(q.totalCents),
      productos: money(q.subtotalCents),
      lineas: q.lines.map((line, i) => ({
        variante_id: input.lines[i]!.variantId,
        cantidad: line.quantity,
        precio_unitario: line.gift ? "regalo" : money(line.unitCents),
        ...(line.gift ? {} : { subtotal: money(line.unitCents * line.quantity) }),
      })),
      envio:
        q.deliveryCents === 0
          ? q.deliveryFreeByPolicy
            ? "gratis por el monto de la compra"
            : "gratis"
          : money(q.deliveryCents),
      ...(q.deliveryListCents > 0 ? { envio_sin_negociar: money(q.deliveryListCents) } : {}),
      ...(q.discountCents > 0 ? { descuento: money(q.discountCents) } : {}),
      ...(absorbed > 0 ? { envio_que_pone_la_tienda: money(absorbed) } : {}),
      ...(q.giftCents > 0 ? { regalo_valorado_en: money(q.giftCents) } : {}),
      // Para que negocie, no para decirlo: no entran en lo que puede escribir (revela el mínimo).
      margen_usado: formatMoney(q.marginUsedCents, ctx.currency),
      margen_que_queda: formatMoney(q.marginCents - q.marginUsedCents, ctx.currency),
      ...(q.negotiated
        ? {
            plazo: `Si lo paga hasta ${momentWords(ctx.timeZone, ctx.offerDeadline, ctx.now)}. Dilo con esa hora exacta: es a cambio de pagar en ese plazo.`,
          }
        : {}),
    }
  })
}

async function createOrder(ctx: SofiToolContext, args: z.infer<typeof orderSchema>) {
  return withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, async (tx) => {
    const input = await toOrderInput(tx, ctx, args, args)
    const priced = await quoteOrderIn(tx, ctx.storeId, input, ctx.today, { byAgent: true })
    if (!priced.quote) return { ok: false, problemas: problemsOf(priced.fields, input) }
    const problem = offerProblem(
      ctx.offer,
      ctx.now,
      priced.quote,
      await collectionOf(tx, ctx.storeId, input.paymentMethodId),
    )
    if (problem) return { ok: false, problemas: [problem] }
    // Solo con un resumen que el cliente ya vio y respondió (tablero 8: «manda el resumen con
    // el total para que el cliente lo confirme»).
    if (!ctx.shownQuotes.has(quoteKey(input, priced.quote.totalCents)))
      throw new ToolProblem(
        "Antes de anotarlo, mándale el resumen con este mismo total (cotizar) y espera su sí",
        "SIN_RESUMEN",
      )
    // Si ya hay un pedido suyo sin pagar en esta conversación (cambió lo que lleva, o paga al
    // recibir), se anula y se anota el nuevo: lo acordado no se cambia (ADR 0207). Uno con un
    // link de pago ya enviado no: el cliente podría pagarlo después.
    const open = (await conversationOrders(tx, ctx)).filter(
      (o) => o.state === "por_pagar" && o.createdBy === SOFI_ACTOR,
    )
    if (open.some((o) => o.linkUrl && (!o.linkExpiresAt || o.linkExpiresAt.getTime() > Date.now())))
      throw new ToolProblem(
        "Ese pedido ya tiene un link de pago enviado: no lo rehagas. Si prefiere Yape o transferencia, anota su captura en el mismo pedido (anotar_pago); si quiere cambiarlo, pásalo a una persona",
        "TIENE_LINK",
      )
    for (const old of open) {
      const [paid] = await tx
        .select({ id: orderPayment.id })
        .from(orderPayment)
        .where(eq(orderPayment.orderId, old.id))
        .limit(1)
      if (paid) continue
      await cancelOrderIn(
        tx,
        ctx.storeId,
        SOFI_ACTOR,
        old.id,
        "Se anotó de nuevo en la conversación",
        {
          mayCancelPaid: false,
          notify: false,
        },
      )
    }
    const created = await createOrderIn(tx, ctx.storeId, SOFI_ACTOR, input, {
      conversationId: ctx.conversationId,
      today: ctx.today,
      test: ctx.test,
      // Vence a la hora que le dijo al ofrecerlo (la de cotizar), no 24 horas desde ahora.
      priceExpiresAt: ctx.offerDeadline,
    })
    // Tomó un pedido: la conversación sube a «pedido» en lo que se cobra, en la misma
    // transacción que el pedido (el de prueba nunca).
    if (!ctx.test)
      await countConversation(
        tx,
        ctx.storeId,
        { id: ctx.conversationId, channel: ctx.channel },
        "pedido",
      )
    await tx
      .update(conversation)
      .set({ customerName: args.nombre.trim().slice(0, 120), updatedAt: new Date() })
      .where(and(eq(conversation.id, ctx.conversationId), eq(conversation.storeId, ctx.storeId)))
    ctx.trace.amounts.add(created.totalCents)
    return {
      ok: true,
      pedido: created.number,
      estado: stateWords({ state: created.state, paymentCollection: created.paymentCollection }),
      total: formatMoney(created.totalCents, ctx.currency),
      ...(open.length ? { reemplaza: open.map((o) => pad(o.number)) } : {}),
      ...(created.priceExpiresAt
        ? {
            plazo: `El precio negociado vale si lo paga hasta ${momentWords(ctx.timeZone, created.priceExpiresAt, ctx.now)}`,
          }
        : {}),
    }
  })
}

async function paymentLink(ctx: SofiToolContext, args: z.infer<typeof SCHEMAS.link_de_pago>) {
  const order = await withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, (tx) =>
    orderOf(tx, ctx, args.pedido),
  )
  try {
    const { url } = await createPaymentLinkWith(
      (fn) => withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, fn),
      SOFI_ACTOR,
      ctx.storeId,
      order.id,
      ctx.link,
    )
    ctx.trace.amounts.add(order.totalCents)
    return {
      ok: true,
      pedido: pad(order.number),
      link: url,
      total: formatMoney(order.totalCents, ctx.currency),
    }
  } catch (error) {
    if (error instanceof StoreError && error.code === "LINK_NOT_CONNECTED")
      throw new ToolProblem(
        "La tienda no tiene link de pago: ofrece la siguiente forma de cobro (captura de Yape o transferencia)",
        "SIN_LINK",
      )
    throw error
  }
}

async function receipt(ctx: SofiToolContext, args: z.infer<typeof SCHEMAS.anotar_pago>) {
  return withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, async (tx) => {
    const order = await orderOf(tx, ctx, args.pedido)
    const cents = centsOf(args.monto, ctx.currency)!
    if (cents < 1) throw new ToolProblem("Escribe el monto que se ve en la captura", "DATOS")
    await addReceiptIn(tx, ctx.storeId, SOFI_ACTOR, order.id, {
      amountCents: cents,
      operation: args.operacion?.trim() || null,
    })
    ctx.trace.amounts.add(cents)
    ctx.trace.amounts.add(order.totalCents)
    // Si pagó una parte (un adelanto), lo que falta sale del mismo saldo que ve el equipo.
    const { dueCents } = await balanceIn(tx, order)
    if (dueCents > 0) ctx.trace.amounts.add(dueCents)
    return {
      ok: true,
      pedido: pad(order.number),
      estado: stateWords({ state: "por_confirmar", paymentCollection: order.paymentCollection }),
      monto_anotado: formatMoney(cents, ctx.currency),
      total_del_pedido: formatMoney(order.totalCents, ctx.currency),
      ...(dueCents > 0
        ? {
            falta_pagar: formatMoney(dueCents, ctx.currency),
            ojo: "Pagó una parte del total: falta pagar el resto",
          }
        : cents !== order.totalCents
          ? { ojo: "El monto anotado pasa del total del pedido" }
          : {}),
    }
  })
}

async function orders(ctx: SofiToolContext) {
  return withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, async (tx) => {
    const rows = await conversationOrders(tx, ctx)
    const balances = await balancesIn(
      tx,
      rows.map((o) => o.id),
    )
    return {
      pedidos: rows.map((o) => {
        ctx.trace.amounts.add(o.totalCents)
        const balance = balances.get(o.id)
        // Si pagó una parte: lo confirmado, lo que espera a una persona y lo que falta, las mismas
        // cifras que ve el equipo. Lo que es 0 no se dice.
        const partial = balance && balance.dueCents > 0 && balance.dueCents < o.totalCents
        const part: Record<string, string> = {}
        if (partial) {
          ctx.trace.amounts.add(balance.dueCents)
          if (balance.confirmedCents > 0) {
            ctx.trace.amounts.add(balance.confirmedCents)
            part.pagado_confirmado = formatMoney(balance.confirmedCents, ctx.currency)
          }
          if (balance.pendingCents > 0) {
            ctx.trace.amounts.add(balance.pendingCents)
            part.por_confirmar = formatMoney(balance.pendingCents, ctx.currency)
          }
          part.falta_pagar = formatMoney(balance.dueCents, ctx.currency)
        }
        return {
          pedido: pad(o.number),
          estado: stateWords(o, balance),
          total: formatMoney(o.totalCents, ctx.currency),
          ...part,
          entrega: o.deliveryName,
          pago: o.paymentName,
          ...(o.tracking ? { numero_de_envio: o.tracking } : {}),
          ...(o.priceExpiresAt && o.state === "por_pagar"
            ? o.priceExpiresAt.getTime() <= Date.now()
              ? { precio: "El precio negociado venció: vuelve a cotizar" }
              : {
                  precio: `Precio negociado vigente si lo paga hasta ${momentWords(ctx.timeZone, o.priceExpiresAt, ctx.now)}`,
                }
            : {}),
        }
      }),
    }
  })
}

async function notifyBack(
  ctx: SofiToolContext,
  args: z.infer<typeof SCHEMAS.avisar_cuando_vuelva>,
) {
  return withAgent(ctx.appDb, SOFI_ACTOR, ctx.storeId, async (tx) => {
    if (!z.uuid().safeParse(args.variante_id).success)
      throw new ToolProblem("Esa variante no está en el catálogo", "DATOS")
    const [variant] = await tx
      .select({ stock: productVariant.stock, removedAt: productVariant.removedAt })
      .from(productVariant)
      .where(and(eq(productVariant.id, args.variante_id), eq(productVariant.storeId, ctx.storeId)))
    if (!variant || variant.removedAt) throw new ToolProblem("Esa variante ya no se vende", "DATOS")
    if (variant.stock > 0) return { ok: true, nota: `Sí hay: quedan ${variant.stock}` }
    await tx
      .insert(stockRequest)
      .values({
        storeId: ctx.storeId,
        variantId: args.variante_id,
        conversationId: ctx.conversationId,
      })
      .onConflictDoNothing()
    return { ok: true, nota: "Anotado: cuando vuelva, se le avisa por aquí" }
  })
}

async function handOff(ctx: SofiToolContext, args: z.infer<typeof SCHEMAS.pasar_a_persona>) {
  ctx.trace.handoff = args.motivo.trim()
  return { ok: true, nota: "Una persona del equipo seguirá la conversación" }
}

const RUN: Record<SofiToolName, (ctx: SofiToolContext, args: never) => Promise<unknown>> = {
  buscar_productos: search,
  cotizar: quote,
  armar_pedido: createOrder,
  link_de_pago: paymentLink,
  anotar_pago: receipt,
  ver_pedidos: orders,
  avisar_cuando_vuelva: notifyBack,
  pasar_a_persona: handOff,
}

/**
 * Corre una herramienta. Lo que la regla de la tienda no deja (un precio bajo el mínimo, algo
 * agotado, un pedido que ya cambió) vuelve como respuesta para el modelo, no como error: así
 * Sofi lo dice y sigue. Un error inesperado sube.
 */
export async function runTool(
  ctx: SofiToolContext,
  name: string,
  rawArgs: string,
): Promise<string> {
  if (!Object.hasOwn(SCHEMAS, name)) {
    ctx.trace.tools.push({ name, ok: false, code: "NO_EXISTE" })
    return JSON.stringify({ ok: false, problema: `No existe la herramienta ${name}` })
  }
  const tool = name as SofiToolName
  let args: unknown
  try {
    args = SCHEMAS[tool].parse(JSON.parse(rawArgs || "{}"))
  } catch {
    ctx.trace.tools.push({ name, ok: false, code: "DATOS" })
    return JSON.stringify({ ok: false, problema: "Los datos no se entendieron: revisa los campos" })
  }
  try {
    const result = (await RUN[tool](ctx, args as never)) as { ok?: boolean }
    ctx.trace.tools.push({ name, ok: result.ok !== false })
    return JSON.stringify(result)
  } catch (error) {
    if (error instanceof ToolProblem || error instanceof StoreError) {
      const code = error instanceof ToolProblem ? error.code : error.code
      ctx.trace.tools.push({ name, ok: false, code })
      return JSON.stringify({ ok: false, problema: error.message })
    }
    ctx.trace.tools.push({ name, ok: false, code: "FALLO" })
    throw error
  }
}
