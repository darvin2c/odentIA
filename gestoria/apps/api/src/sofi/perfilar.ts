import {
  argosReading,
  type CustomerFactKey,
  type CustomerFactSource,
  conversationMessage,
  customer,
  customerFact,
  type Db,
  saleOrder,
} from "@gestoria/db"
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm"
import { ARGOS_ACTOR, withAgent } from "../agente.js"
import {
  currentOf,
  type FactRow,
  factRowsIn,
  familyIn,
  instagramHandle,
  isBirthday,
  type MeasureCatalog,
  measureCatalogIn,
} from "../perfil.js"
import { addUsage, type ChatModel, costMicros, NO_USAGE, type Usage } from "./modelo.js"
import { BOUGHT_STATES as BOUGHT } from "./sofi.js"

/**
 * Argos perfila a cada clienta (ADR 0240): anota lo que sabe de ella en `customer_fact`, cada dato
 * con su fuente, su cita y su hora, y la ficha lo muestra en «Lo que Argos sabe de ella».
 *
 * - De sus pedidos, con cuentas fijas (sin modelo): su medida es la que más se repite en lo que
 *   compró; si dos empatan, usa la más reciente y deja las otras «Por confirmar». Su canal es por
 *   donde más le escribe a la tienda.
 * - De lo que ella escribió y de la dirección de su última entrega, con el modelo de Sofi: solo
 *   para leer. Lo que dice ella va como mensaje del usuario, nunca en el de sistema. Cada dato trae
 *   su cita y el código comprueba que está tal cual en un mensaje de ella (o en la dirección), que
 *   la medida existe en el catálogo y que el cumpleaños es un día del calendario: lo que no pasa se
 *   descarta. Lee cada mensaje una vez (`argos_reading`), solo conversaciones con una clienta y
 *   nunca a media conversación.
 * - Lo que corrigió la tienda no se vuelve a escribir (la base además lo niega: si choca, sigue con
 *   lo demás). Si el dato ya dice eso, no suma otra fila.
 *
 * Lo que cuesta leer con el modelo queda en la vuelta de Argos (el registro del servidor): no se
 * le cobra a la tienda.
 */

/** No se lee una conversación a medias: su último mensaje tiene que tener esto o más. */
export const QUIET_MS = 30 * 60_000
/** Cuántas conversaciones lee el modelo por tienda en cada vuelta (lo demás, en la siguiente). */
export const MAX_READS = 20
/** Cuántos mensajes nuevos de ella lee de una vez, los últimos. */
const MAX_MESSAGES = 40
/** Hasta cuántas posibilidades guarda un dato que no está claro (la base acepta cuatro). */
const MAX_ALTERNATIVES = 4

/** Lo que el modelo puede leer de lo que ella dijo (el canal sale de las cuentas). */
const READ_KEYS = ["medida", "distrito", "cumpleanos", "instagram", "gustos"] as const
type ReadKey = (typeof READ_KEYS)[number]

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()

/** Si `word` está en `text` como palabra suelta («38» en «¿hay en 38?», no en «380»). */
function hasWord(text: string, word: string): boolean {
  const escaped = fold(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(fold(text))
}

export interface ProfileRun {
  /** Las filas que anotó Argos. */
  written: number
  /** Lo que no se anotó porque la base lo negó (lo corrigió la tienda mientras tanto). */
  refused: number
  /** Las conversaciones que leyó el modelo. */
  read: number
  /** Las que no pudo leer (el modelo falló): se leen en otra vuelta. */
  failed: number
  /** Lo que el modelo propuso y no pasó la comprobación. */
  discarded: number
  usage: Usage
  costMicros: number | null
}

const emptyRun = (): ProfileRun => ({
  written: 0,
  refused: 0,
  read: 0,
  failed: 0,
  discarded: 0,
  usage: NO_USAGE,
  costMicros: null,
})

/** Un dato por anotar, con su origen. */
interface Fact {
  key: CustomerFactKey
  value: string
  source: Exclude<CustomerFactSource, "tienda">
  messageId?: string | null
  orderId?: string | null
  quote?: string | null
  alternatives?: string[]
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i])

/**
 * Anota un dato en la ficha que se ve, si hace falta: nunca uno que la tienda corrigió, y no otra
 * fila igual a la de hoy (ni a la última que salió de esa misma fuente: lo que dijo en el chat no
 * lo tapa otra vez la misma cuenta de sus compras). Cada fila va en su propio punto de guardado:
 * si la base la niega, sigue con lo demás.
 */
async function noteFact(
  tx: Db,
  storeId: string,
  rootId: string,
  rows: FactRow[],
  fact: Fact,
  run: ProfileRun,
): Promise<void> {
  const mine = rows.filter((r) => r.key === fact.key)
  if (mine.some((r) => r.source === "tienda")) return
  const alternatives = (fact.alternatives ?? [])
    .filter((v) => v !== fact.value)
    .slice(0, MAX_ALTERNATIVES)
  const now = currentOf(rows, fact.key)
  if (now && now.value === fact.value && sameList(now.alternatives, alternatives)) return
  const lastSame = mine.find((r) => r.source === fact.source)
  if (
    lastSame &&
    fact.source !== "chat" &&
    lastSame.value === fact.value &&
    sameList(lastSame.alternatives, alternatives)
  )
    return
  try {
    await tx.transaction(async (point) => {
      await point.insert(customerFact).values({
        storeId,
        customerId: rootId,
        key: fact.key,
        value: fact.value,
        source: fact.source,
        messageId: fact.messageId ?? null,
        orderId: fact.orderId ?? null,
        quote: fact.quote ?? null,
        alternatives,
        actorUserId: ARGOS_ACTOR,
      })
    })
    run.written += 1
  } catch {
    // La tienda lo corrigió mientras tanto (`customer_fact_store_wins`): manda lo de ella.
    run.refused += 1
  }
}

/* ----------------------------------------------------------- las cuentas fijas */

interface Tally {
  count: number
  lastAt: number
  orderId: string
}

/** El más repetido; si empatan, el más reciente, y los otros del empate «Por confirmar». */
export function mostUsed(tallies: Map<string, Tally>): { value: string; tie: string[] } | null {
  const sorted = [...tallies.entries()].sort(
    ([, a], [, b]) => b.count - a.count || b.lastAt - a.lastAt,
  )
  const top = sorted[0]
  if (!top) return null
  const tie = sorted.filter(([, t]) => t.count === top[1].count).map(([value]) => value)
  return { value: top[0], tie: tie.slice(1) }
}

/** Las medidas que compró cada familia (lo que ya es compra, nunca lo de prueba ni los regalos). */
async function boughtMeasuresIn(tx: Db, storeId: string, catalog: MeasureCatalog) {
  const rows = await tx.execute<{
    root: string
    order_id: string
    created_at: Date | string
    product_id: string
    option_values: string[]
  }>(sql`
    select coalesce(c.merged_into, c.id) as root, o.id as order_id, o.created_at,
      v.product_id, v.option_values
    from sale_order o
    join customer c on c.id = o.customer_id
    join sale_order_line l on l.order_id = o.id
    join product_variant v on v.id = l.variant_id
    left join order_balance b on b.order_id = o.id
    where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
      and l.gift = false
      and (o.state in (${sql.join(
        BOUGHT.map((s) => sql`${s}`),
        sql`, `,
      )}) or coalesce(b.confirmed_cents, 0) + coalesce(b.pending_cents, 0) > 0)`)
  const byRoot = new Map<string, Map<string, Tally>>()
  for (const row of rows) {
    const i = catalog.indexOf.get(row.product_id)
    const value = i === undefined ? undefined : row.option_values[i]?.trim()
    if (!value) continue
    const at = new Date(row.created_at).getTime()
    const tallies = byRoot.get(row.root) ?? new Map<string, Tally>()
    const tally = tallies.get(value) ?? { count: 0, lastAt: 0, orderId: row.order_id }
    tally.count += 1
    if (at >= tally.lastAt) {
      tally.lastAt = at
      tally.orderId = row.order_id
    }
    tallies.set(value, tally)
    byRoot.set(row.root, tallies)
  }
  return byRoot
}

/** Por dónde le escribe cada familia: sus mensajes en las conversaciones de sus pedidos. */
async function writtenChannelsIn(tx: Db, storeId: string) {
  const rows = await tx.execute<{
    root: string
    channel: string
    n: number | string
    last_at: Date | string
  }>(sql`
    with pairs as (
      select distinct coalesce(c.merged_into, c.id) as root, o.conversation_id
      from sale_order o join customer c on c.id = o.customer_id
      where o.store_id = ${storeId} and o.conversation_id is not null and o.test = false
    )
    select p.root, conv.channel, count(m.id) as n, max(m.created_at) as last_at
    from pairs p
    join conversation conv on conv.id = p.conversation_id
    join conversation_message m on m.conversation_id = conv.id and m.author = 'cliente'
    where conv.channel <> 'prueba'
    group by p.root, conv.channel`)
  const byRoot = new Map<string, Map<string, Tally>>()
  for (const row of rows) {
    const tallies = byRoot.get(row.root) ?? new Map<string, Tally>()
    tallies.set(row.channel, {
      count: Number(row.n),
      lastAt: new Date(row.last_at).getTime(),
      orderId: "",
    })
    byRoot.set(row.root, tallies)
  }
  return byRoot
}

/** Lo de las cuentas fijas de toda la tienda: la medida de sus compras y su canal. */
async function countFactsIn(tx: Db, storeId: string, run: ProfileRun) {
  const catalog = await measureCatalogIn(tx, storeId)
  const measures = await boughtMeasuresIn(tx, storeId, catalog)
  const channels = await writtenChannelsIn(tx, storeId)
  for (const root of new Set([...measures.keys(), ...channels.keys()])) {
    const rows = await factRowsIn(tx, storeId, await familyIn(tx, storeId, root))
    const size = measures.get(root)
    const top = size ? mostUsed(size) : null
    if (size && top)
      await noteFact(
        tx,
        storeId,
        root,
        rows,
        {
          key: "medida",
          value: top.value,
          source: "pedido",
          orderId: size.get(top.value)!.orderId,
          alternatives: top.tie,
        },
        run,
      )
    const channel = channels.get(root)
    const best = channel ? mostUsed(channel) : null
    if (best)
      await noteFact(
        tx,
        storeId,
        root,
        rows,
        { key: "canal", value: best.value, source: "respuesta", alternatives: best.tie },
        run,
      )
  }
}

/* -------------------------------------------------------- lo que ella dijo */

/** Lo que el modelo lee de una conversación. */
export interface Reading {
  conversationId: string
  rootId: string
  /** Sus mensajes nuevos, en orden. */
  messages: { id: string; seq: number; text: string }[]
  /** Hasta dónde queda leída. */
  lastSeq: number
  /** La dirección de su última entrega, con su pedido. */
  address: { orderId: string; text: string } | null
}

/**
 * Las conversaciones por leer: de verdad (sin «Probar a Sofi»), con una clienta (la ficha de sus
 * pedidos), con mensajes de ella que Argos no leyó y cuyo último mensaje de ella tiene al menos
 * `QUIET_MS`: no se lee a media conversación.
 */
export async function readingsIn(tx: Db, storeId: string, now: Date): Promise<Reading[]> {
  const quietSince = new Date(now.getTime() - QUIET_MS).toISOString()
  const pending = await tx.execute<{ id: string; cursor: number | string }>(sql`
    select conv.id, coalesce(r.seq, 0) as cursor
    from conversation conv
    left join argos_reading r on r.store_id = conv.store_id and r.conversation_id = conv.id
    join conversation_message m on m.conversation_id = conv.id and m.author = 'cliente'
    where conv.store_id = ${storeId} and conv.channel <> 'prueba'
      and exists (select 1 from sale_order o where o.conversation_id = conv.id
        and o.customer_id is not null and o.test = false)
    group by conv.id, r.seq
    having max(m.seq) > coalesce(r.seq, 0) and max(m.created_at) <= ${quietSince}
    order by max(m.created_at)
    limit ${MAX_READS}`)
  const readings: Reading[] = []
  for (const row of pending) {
    const [last] = await tx
      .select({ customerId: saleOrder.customerId })
      .from(saleOrder)
      .where(
        and(
          eq(saleOrder.storeId, storeId),
          eq(saleOrder.conversationId, row.id),
          isNotNull(saleOrder.customerId),
          eq(saleOrder.test, false),
        ),
      )
      .orderBy(desc(saleOrder.createdAt))
      .limit(1)
    if (!last?.customerId) continue
    const [head] = await tx
      .select({ id: customer.id, mergedInto: customer.mergedInto })
      .from(customer)
      .where(eq(customer.id, last.customerId))
    if (!head) continue
    const rootId = head.mergedInto ?? head.id
    const news = await tx
      .select({
        id: conversationMessage.id,
        seq: conversationMessage.seq,
        text: conversationMessage.text,
      })
      .from(conversationMessage)
      .where(
        and(
          eq(conversationMessage.storeId, storeId),
          eq(conversationMessage.conversationId, row.id),
          eq(conversationMessage.author, "cliente"),
          gt(conversationMessage.seq, Number(row.cursor)),
        ),
      )
      .orderBy(desc(conversationMessage.seq))
      .limit(MAX_MESSAGES)
    if (news.length === 0) continue
    const messages = news.reverse()
    const family = await familyIn(tx, storeId, rootId)
    // Su última entrega: el último pedido de la familia con dirección (no el de prueba ni anulado).
    const [delivery] = await tx.execute<{ id: string; address: string }>(sql`
      select o.id, o.address from sale_order o
      where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
        and btrim(o.address) <> ''
        and o.customer_id in (${sql.join(
          family.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      order by o.created_at desc limit 1`)
    readings.push({
      conversationId: row.id,
      rootId,
      messages,
      lastSeq: messages.at(-1)!.seq,
      address: delivery ? { orderId: delivery.id, text: delivery.address } : null,
    })
  }
  return readings
}

/**
 * Lo que lee el modelo: el mensaje de sistema es fijo (solo cambia con la medida de la tienda) y
 * lo de ella va como mensaje del usuario.
 */
export function readingMessages(catalog: MeasureCatalog, reading: Reading) {
  const sizes = [...catalog.values.values()]
  const system = [
    "Lees lo que escribió una clienta de una tienda que vende por chat, para anotar en su ficha lo que dijo de sí misma. No le respondes a nadie.",
    'Devuelve solo un arreglo JSON, sin texto alrededor: [{"clave": "…", "valor": "…", "cita": "…"}]. Si no dijo nada de esto, devuelve [].',
    "Las claves:",
    `- "medida": su ${catalog.label.toLowerCase()}, solo si es una de estas: ${sizes.length ? sizes.join(", ") : "(la tienda no tiene)"}.`,
    '- "distrito": el distrito o la zona donde recibe sus pedidos, como lo dice ella o la dirección.',
    '- "cumpleanos": su cumpleaños, como --MM-DD (sin año). Solo si es el de ella.',
    '- "instagram": su usuario de Instagram, como @usuario.',
    '- "gustos": lo que le gusta o busca seguido, en pocas palabras.',
    '"cita": las palabras exactas de donde lo sacaste, copiadas tal cual de uno de sus mensajes o de la dirección, sin corregir nada.',
    "Solo lo que dijo de ella misma: lo que pide para otra persona (un regalo, su hija) no es suyo. Nunca supongas ni completes: si no lo dijo, no va.",
  ].join("\n")
  const user = [
    "Sus mensajes:",
    ...reading.messages.map((m) => `- ${m.text}`),
    ...(reading.address ? ["", "La dirección de su última entrega:", reading.address.text] : []),
  ].join("\n")
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ]
}

interface Claim {
  clave: string
  valor: string
  cita: string
}

/** El arreglo que devolvió el modelo, o null si no se puede leer. */
export function parseClaims(content: string | null): Claim[] | null {
  if (!content) return null
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed.filter(
    (item): item is Claim =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Claim).clave === "string" &&
      typeof (item as Claim).valor === "string" &&
      typeof (item as Claim).cita === "string",
  )
}

/** Un dato comprobado, con dónde está su cita (el número de mensaje, o -1 para la dirección). */
interface Checked {
  fact: Fact & { key: ReadKey }
  at: number
}

/**
 * Lo que propuso el modelo, comprobado en el código: la cita está tal cual en un mensaje de ella
 * (fuente «chat») o en la dirección (fuente «pedido»), y el valor vale. Lo demás se descarta.
 */
export function checkClaims(
  claims: Claim[],
  reading: Reading,
  catalog: MeasureCatalog,
): { checked: Checked[]; discarded: number } {
  const checked: Checked[] = []
  let discarded = 0
  for (const claim of claims) {
    const key = claim.clave.trim() as ReadKey
    const quote = claim.cita.trim()
    if (!(READ_KEYS as readonly string[]).includes(key) || !quote || quote.length > 300) {
      discarded += 1
      continue
    }
    const said = [...reading.messages].reverse().find((m) => m.text.includes(quote))
    const inAddress = !said && reading.address?.text.includes(quote)
    if (!said && !inAddress) {
      discarded += 1
      continue
    }
    let value: string | null = null
    const raw = claim.valor.trim()
    if (key === "medida") {
      const known = catalog.values.get(fold(raw))
      value = known && hasWord(quote, known) ? known : null
    } else if (key === "cumpleanos") value = isBirthday(raw) ? raw : null
    else if (key === "instagram") {
      const handle = instagramHandle(raw)
      value = handle && fold(quote).includes(handle.slice(1)) ? handle : null
    } else {
      const text = raw.replace(/\s+/g, " ")
      value = text.length >= 1 && text.length <= 120 ? text : null
    }
    if (!value) {
      discarded += 1
      continue
    }
    checked.push({
      fact: said
        ? { key, value, source: "chat", messageId: said.id, quote }
        : { key, value, source: "pedido", orderId: reading.address!.orderId, quote },
      at: said ? said.seq : -1,
    })
  }
  return { checked, discarded }
}

/**
 * Un dato por clave: lo último que dijo. Si dijo dos medidas distintas, usa la que más compra (si
 * es una de ellas) o la última, y deja la otra «Por confirmar».
 */
export function pickFacts(checked: Checked[], boughtSize: string | null): Fact[] {
  const picked: Fact[] = []
  for (const key of READ_KEYS) {
    const mine = checked.filter((c) => c.fact.key === key).sort((a, b) => b.at - a.at)
    const latest = mine[0]
    if (!latest) continue
    if (key !== "medida") {
      picked.push(latest.fact)
      continue
    }
    const values = [...new Set(mine.map((c) => c.fact.value))]
    const chosen =
      values.length > 1 && boughtSize && values.includes(boughtSize)
        ? mine.find((c) => c.fact.value === boughtSize)!
        : latest
    picked.push({
      ...chosen.fact,
      alternatives: values.filter((v) => v !== chosen.fact.value),
    })
  }
  return picked
}

/** La medida que más compró, según lo anotado de sus pedidos. */
function boughtSizeOf(rows: FactRow[]): string | null {
  return rows.find((r) => r.key === "medida" && r.source === "pedido")?.value ?? null
}

/* ------------------------------------------------------------------ la vuelta */

/**
 * Perfila a las clientas de una tienda: primero las cuentas fijas y después, con modelo, lo que
 * ellas escribieron. Cada conversación se lee fuera de toda transacción y se anota en la suya: si
 * el modelo falla, su cursor no avanza y se lee en otra vuelta.
 */
export async function profileStore(
  appDb: Db,
  storeId: string,
  now: Date,
  model: ChatModel | null = null,
): Promise<ProfileRun> {
  const run = emptyRun()
  const readings = await withAgent(appDb, ARGOS_ACTOR, storeId, async (tx) => {
    await countFactsIn(tx, storeId, run)
    if (!model) return null
    return {
      catalog: await measureCatalogIn(tx, storeId),
      list: await readingsIn(tx, storeId, now),
    }
  })
  if (!model || !readings) return run
  const { catalog } = readings
  for (const reading of readings.list) {
    let claims: Claim[] | null = null
    try {
      const reply = await model.complete({
        messages: readingMessages(catalog, reading),
        temperature: 0,
        toolChoice: "none",
      })
      run.usage = addUsage(run.usage, reply.usage)
      claims = parseClaims(reply.content)
    } catch {
      claims = null
    }
    if (!claims) {
      run.failed += 1
      continue
    }
    run.read += 1
    const { checked, discarded } = checkClaims(claims, reading, catalog)
    run.discarded += discarded
    await withAgent(appDb, ARGOS_ACTOR, storeId, async (tx) => {
      const family = await familyIn(tx, storeId, reading.rootId)
      const rows = await factRowsIn(tx, storeId, family)
      for (const fact of pickFacts(checked, boughtSizeOf(rows)))
        await noteFact(tx, storeId, reading.rootId, rows, fact, run)
      // Leída hasta aquí: el cursor solo avanza.
      await tx
        .insert(argosReading)
        .values({ storeId, conversationId: reading.conversationId, seq: reading.lastSeq })
        .onConflictDoUpdate({
          target: [argosReading.storeId, argosReading.conversationId],
          set: {
            seq: sql`greatest(${argosReading.seq}, excluded.seq)`,
            readAt: sql`now()`,
          },
        })
    })
  }
  run.costMicros = run.read || run.failed ? costMicros(model.name, run.usage) : null
  return run
}

/** Para las pruebas y la demo: lo que leyó y anotó de una conversación. */
export async function readingOf(tx: Db, storeId: string, conversationId: string) {
  const [row] = await tx
    .select({ seq: argosReading.seq })
    .from(argosReading)
    .where(and(eq(argosReading.storeId, storeId), eq(argosReading.conversationId, conversationId)))
  return row?.seq ?? null
}
