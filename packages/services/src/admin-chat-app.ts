/**
 * De qué app le hablan a Sallca en una conversación (A1 del lienzo «Una sola
 * administración para todas las apps»). El Grupo Sallca vende todas sus apps por
 * un solo WhatsApp, así que la conversación guarda su app (`saas_chat.product`)
 * y cómo se supo (`product_source`):
 *
 * - `anuncio`: el mensaje llegó desde un anuncio de Meta (`referral` del aviso
 *   de WhatsApp) que una persona ya ató a su app. Un anuncio que nadie ató queda
 *   en Hoy («Anuncios por atar») con su título y su texto; al atarlo, las
 *   conversaciones que abrió y siguen sin app pasan a esa.
 * - `enlace`: el primer mensaje es el texto ya escrito de un enlace
 *   (`salesWhatsAppText`: «Hola, quiero información de latidIA»).
 * - `lo_dijo`: la persona nombró una sola app, o se lo dijo a Kairós
 *   («tengo una óptica») y Kairós lo anotó (`kairosChooseChatProduct`).
 * - `persona`: alguien de Administración la eligió en la conversación. Lo que
 *   elige una persona no lo cambia Kairós.
 *
 * Si la conversación es de un cliente, manda la app de su ficha, diga lo que
 * diga la entrada (`chatAppOf`). Sin nada de eso, la app no se sabe y Kairós
 * saluda como Grupo Sallca y pregunta: nunca se asume una app.
 */
import {
  CLINICAL_PRODUCTS,
  type ClinicalProduct,
  isClinicalProduct,
  productWords,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  type SaasChatProductSource,
  saasAd,
  saasChat,
  saasClient,
} from "@odentia/db/schema/admin-arm"
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { invalidField, notFound, ServiceError } from "./errors.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** El nombre de quien vende todas las apps, como se presenta en los chats. */
export const SALES_GROUP_NAME = "Grupo Sallca"

/** La app de una conversación y cómo se supo; `cliente` es la de la ficha de su cliente. */
export interface ChatApp {
  product: ClinicalProduct
  source: SaasChatProductSource | "cliente"
}

/** Lo que se ve junto a la app: «por el anuncio», «lo dijo»… */
export const CHAT_APP_SOURCE_WORDS: Record<ChatApp["source"], string> = {
  anuncio: "por el anuncio",
  enlace: "por el enlace",
  lo_dijo: "lo dijo",
  persona: "la eligió el equipo",
  cliente: "de su ficha",
}

/** La app de una conversación: la de la ficha de su cliente si tiene, si no la que se supo. */
export function chatAppOf(
  chat: { product: string | null; productSource: string | null },
  client: { product: string } | null,
): ChatApp | null {
  if (client && isClinicalProduct(client.product))
    return { product: client.product, source: "cliente" }
  if (chat.product && isClinicalProduct(chat.product) && chat.productSource)
    return { product: chat.product, source: chat.productSource as SaasChatProductSource }
  return null
}

/** El texto ya escrito del botón o del enlace de WhatsApp de cada app (wa.me solo admite eso). */
export function salesWhatsAppText(product: ClinicalProduct): string {
  return `Hola, quiero información de ${productWords(product).name}`
}

/** El enlace de WhatsApp de una app al número de ventas (E.164), con su texto ya escrito. */
export function salesWhatsAppLink(phone: string, product: ClinicalProduct): string {
  return `https://wa.me/${phone.replace(/[^\d]/g, "")}?text=${encodeURIComponent(salesWhatsAppText(product))}`
}

/** Sin tildes, sin mayúsculas, sin signos y con un solo espacio. */
function plainWords(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/**
 * Lo que dice el texto de un mensaje sobre la app, sin modelo: el mensaje ya escrito de un
 * enlace (`enlace`) o el nombre de una sola app (`lo_dijo`). Dos apps nombradas, o ninguna, no
 * dicen nada: entonces pregunta Kairós.
 */
export function chatProductFromText(
  text: string | null | undefined,
): { product: ClinicalProduct; source: "enlace" | "lo_dijo" } | null {
  const said = plainWords(text ?? "")
  if (!said) return null
  for (const product of CLINICAL_PRODUCTS)
    if (
      said === plainWords(salesWhatsAppText(product)) ||
      said.startsWith(`${plainWords(salesWhatsAppText(product))} `)
    )
      return { product, source: "enlace" }
  const words = new Set(said.split(" "))
  const named = CLINICAL_PRODUCTS.filter((product) =>
    words.has(plainWords(productWords(product).name)),
  )
  return named.length === 1 && named[0] ? { product: named[0], source: "lo_dijo" } : null
}

/** Lo que trae un mensaje de WhatsApp que llegó desde un anuncio (`messages[].referral`). */
export interface ChatReferral {
  sourceId: string
  sourceType?: string | null
  headline?: string | null
  body?: string | null
  sourceUrl?: string | null
}

const cut = (value: string | null | undefined, max: number) => {
  const clean = (value ?? "").trim()
  return clean ? clean.slice(0, max) : null
}

/**
 * Guarda el anuncio que abrió el mensaje (una vez por su id en Meta; su título y su texto se
 * actualizan si cambian) y devuelve su fila. Un id vacío o raro no guarda nada.
 */
export async function recordChatAd(
  tx: Db,
  referral: ChatReferral,
  now = new Date(),
): Promise<typeof saasAd.$inferSelect | null> {
  const sourceId = cut(referral.sourceId, 128)
  if (!sourceId || /\s/.test(sourceId)) return null
  const values = {
    sourceType: cut(referral.sourceType, 40),
    headline: cut(referral.headline, 300),
    body: cut(referral.body, 2000),
    sourceUrl: cut(referral.sourceUrl, 2000),
  }
  const [row] = await tx
    .insert(saasAd)
    .values({ sourceId, ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: saasAd.sourceId,
      set: {
        sourceType: sql`coalesce(excluded.source_type, ${saasAd.sourceType})`,
        headline: sql`coalesce(excluded.headline, ${saasAd.headline})`,
        body: sql`coalesce(excluded.body, ${saasAd.body})`,
        sourceUrl: sql`coalesce(excluded.source_url, ${saasAd.sourceUrl})`,
        updatedAt: now,
      },
    })
    .returning()
  return row ?? null
}

/**
 * Lo que dice un mensaje que entra sobre la app de su conversación (lo llama `ingestInboundChat`,
 * en su transacción): el anuncio queda ligado a la conversación si es el primero, y una
 * conversación sin app y sin cliente toma la del anuncio (si ya está atado) o la que dice el texto.
 * Nunca pisa una app que ya tiene.
 */
export async function learnChatProduct(
  tx: Db,
  chat: typeof saasChat.$inferSelect,
  input: { body: string | null; referral: ChatReferral | null },
  now = new Date(),
): Promise<void> {
  const ad = input.referral ? await recordChatAd(tx, input.referral, now) : null
  const set: Partial<typeof saasChat.$inferInsert> = {}
  if (ad && !chat.adId) set.adId = ad.id
  if (!chat.product && !chat.clientId) {
    const fromAd =
      ad?.product && isClinicalProduct(ad.product)
        ? { product: ad.product, source: "anuncio" as const }
        : null
    const learned = fromAd ?? chatProductFromText(input.body)
    if (learned) {
      set.product = learned.product
      set.productSource = learned.source
    }
  }
  if (Object.keys(set).length === 0) return
  await tx
    .update(saasChat)
    .set({ ...set, updatedAt: now })
    .where(eq(saasChat.id, chat.id))
  if (set.product)
    await writeAdminAudit(tx, null, {
      action: "inbound.chat_product",
      entityId: chat.id,
      metadata: { chatId: chat.id, product: set.product, source: set.productSource ?? null },
    })
}

function requireAdmin(actor: AdminActor): void {
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración puede hacer esto")
}

function productOrThrow(value: unknown): ClinicalProduct {
  if (!isClinicalProduct(value)) throw invalidField("product", "Elige una de las apps")
  return value
}

/**
 * «Cambiar la app» de una conversación, en la Bandeja: solo Administración (las conversaciones
 * son suyas, ADR 0196). Una conversación con cliente usa la app de su ficha: ahí no se elige.
 */
export async function setChatProduct(
  tx: Db,
  actor: AdminActor,
  chatId: string,
  rawProduct: unknown,
  now = new Date(),
): Promise<ChatApp> {
  requireAdmin(actor)
  const product = productOrThrow(rawProduct)
  if (!UUID.test(chatId)) throw notFound("Conversación")
  const [chat] = await tx
    .select()
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .for("update")
    .limit(1)
  if (!chat) throw notFound("Conversación")
  if (chat.clientId)
    throw new ServiceError(
      "CHAT_HAS_CLIENT",
      409,
      "Esta conversación es de un cliente: su app es la de su ficha",
    )
  await tx
    .update(saasChat)
    .set({ product, productSource: "persona", updatedAt: now })
    .where(eq(saasChat.id, chat.id))
  await writeAdminAudit(tx, actor, {
    action: "chat.product_set",
    entityId: chat.id,
    metadata: { chatId: chat.id, product, before: chat.product },
  })
  return { product, source: "persona" }
}

/**
 * Kairós anota la app que dijo la persona («tengo una óptica»). Lo que eligió alguien del equipo
 * se queda; con cliente manda su ficha. Devuelve la app con la que sigue la conversación.
 */
export async function kairosChooseChatProduct(
  tx: Db,
  chatId: string,
  rawProduct: unknown,
  now = new Date(),
): Promise<ChatApp> {
  const product = productOrThrow(rawProduct)
  if (!UUID.test(chatId)) throw notFound("Conversación")
  const [chat] = await tx
    .select()
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .for("update")
    .limit(1)
  if (!chat) throw notFound("Conversación")
  const [client] = chat.clientId
    ? await tx
        .select({ product: saasClient.product })
        .from(saasClient)
        .where(eq(saasClient.id, chat.clientId))
        .limit(1)
    : []
  const kept = chatAppOf(chat, client ?? null)
  if (kept && (kept.source === "cliente" || kept.source === "persona")) return kept
  // La misma app que ya tenía: queda como se supo.
  if (kept?.product === product) return kept
  await tx
    .update(saasChat)
    .set({ product, productSource: "lo_dijo", updatedAt: now })
    .where(eq(saasChat.id, chat.id))
  await writeAdminAudit(tx, null, {
    action: "kairos.chat_product",
    entityId: chat.id,
    metadata: { chatId: chat.id, product, before: chat.product },
  })
  return { product, source: "lo_dijo" }
}

/** Un anuncio que nadie ató todavía a su app, para Hoy. */
export interface AdToTie {
  id: string
  sourceId: string
  headline: string | null
  body: string | null
  sourceUrl: string | null
  firstSeenAt: Date
  /** Cuántas conversaciones abrió y siguen sin app. */
  waiting: number
}

/**
 * Los anuncios sin app (Hoy, «Anuncios por atar»): primero los que tienen más conversaciones
 * esperando, después el más viejo. Solo Administración.
 */
export async function listAdsToTie(tx: Db, actor: AdminActor): Promise<AdToTie[]> {
  requireAdmin(actor)
  const rows = await tx
    .select({
      id: saasAd.id,
      sourceId: saasAd.sourceId,
      headline: saasAd.headline,
      body: saasAd.body,
      sourceUrl: saasAd.sourceUrl,
      firstSeenAt: saasAd.createdAt,
      waiting: sql<number>`(select count(*)::int from admin.saas_chat c
        where c.ad_id = "admin"."saas_ad"."id" and c.product is null and c.client_id is null)`,
    })
    .from(saasAd)
    .where(isNull(saasAd.product))
    .orderBy(
      desc(sql`(select count(*) from admin.saas_chat c
        where c.ad_id = "admin"."saas_ad"."id" and c.product is null and c.client_id is null)`),
      asc(saasAd.createdAt),
      asc(saasAd.id),
    )
    .limit(50)
  return rows.map((row) => ({ ...row, waiting: Number(row.waiting ?? 0) }))
}

/**
 * Ata un anuncio a su app: desde ahí cada conversación que abra nace con esa app, y las que ya
 * abrió y siguen sin app ni cliente la toman (`anuncio`). Solo Administración. Se puede volver a
 * atar a otra app: cambia el anuncio y las suyas sin cliente que tomaron la app del anuncio.
 */
export async function setAdProduct(
  tx: Db,
  actor: AdminActor,
  adId: string,
  rawProduct: unknown,
  now = new Date(),
): Promise<{ product: ClinicalProduct; chats: number }> {
  requireAdmin(actor)
  const product = productOrThrow(rawProduct)
  if (!UUID.test(adId)) throw notFound("Anuncio")
  const [ad] = await tx.select().from(saasAd).where(eq(saasAd.id, adId)).for("update").limit(1)
  if (!ad) throw notFound("Anuncio")
  await tx
    .update(saasAd)
    .set({ product, decidedBy: actor.userId, decidedAt: now, updatedAt: now })
    .where(eq(saasAd.id, ad.id))
  const moved = await tx
    .update(saasChat)
    .set({ product, productSource: "anuncio", updatedAt: now })
    .where(
      and(
        eq(saasChat.adId, ad.id),
        isNull(saasChat.clientId),
        or(
          isNull(saasChat.product),
          and(eq(saasChat.productSource, "anuncio"), ne(saasChat.product, product)),
        ),
      ),
    )
    .returning({ id: saasChat.id })
  await writeAdminAudit(tx, actor, {
    action: "chat.ad_product_set",
    entityId: ad.id,
    metadata: {
      adId: ad.id,
      sourceId: ad.sourceId,
      product,
      before: ad.product,
      chats: moved.length,
    },
  })
  return { product, chats: moved.length }
}

/** El nombre de cada app, para lo que no puede nombrar ninguna mientras no se sepa cuál es. */
export const SALES_APP_NAMES: Record<ClinicalProduct, string> = Object.fromEntries(
  CLINICAL_PRODUCTS.map((product) => [product, productWords(product).name]),
) as Record<ClinicalProduct, string>
