import {
  type AiLookKind,
  type AiProposalState,
  aiLook,
  aiProposal,
  bulkLoad,
  bulkLoadItem,
  bulkLoadPhoto,
  type Db,
  PRODUCT_RUBROS,
  type ProductRubro,
  product,
  productColor,
  productPhoto,
} from "@gestoria/db"
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { z } from "zod"
import { agentStopIn, countPhotoLook } from "./acuerdo.js"
import type { Storage } from "./archivos.js"
import { applyItem, colorsOf, itemRow, joinPhotosIn, loadItemPatch, openLoadRow } from "./cargas.js"
import {
  detailIn,
  forRole,
  namesOf,
  productPatch,
  productRow,
  updatePhotoIn,
  updateProductIn,
  uuidOr404,
} from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { type GridInput, hexInput, saveGridIn } from "./ficha.js"
import { startOfDay, storeClockIn } from "./hora.js"
import {
  groupLoosePhotos,
  LookError,
  type LookResult,
  lookAtProduct,
  MAX_GROUP_PHOTOS,
  MAX_LOOK_PHOTOS,
  type PhotoIn,
  rewriteText,
} from "./ia-fotos.js"
import { can } from "./permisos.js"
import { RUBROS, type TemplateField, templateIn } from "./rubros.js"
import { type ChatModel, costMicros, ModelError } from "./sofi/modelo.js"
import { sameText } from "./texto.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Las propuestas de la IA de fotos (lienzo «La ficha del producto», decisiones 3, 7, 9 y 10): la
 * IA mira y propone; una persona con `configuracion` usa, cambia o descarta cada propuesta, o
 * «Aplicar todos». Usar una pasa por la operación de siempre de la ficha (`updateProductIn`,
 * `saveGridIn`, `updatePhotoIn`) o de la carga (`applyItem`, `joinPhotosIn`), con su historial:
 * la IA nunca escribe en la ficha. Verlas es `catalogo.ver` (las de una carga, `configuracion`,
 * como la carga).
 *
 * Mirar sale del saldo del plan, con un tope de fotos por día y tienda (`capPerDay`): al llegar,
 * la persona lo sabe y sigue cargando a mano; nada se frena. Si la administración detuvo a Sofi
 * por el saldo o el tope del plan (`agentStopIn`), la IA de fotos también se detiene.
 *
 * El modelo se llama fuera de toda transacción: primero se anota que mira (`ai_look`, lo que
 * cuenta para el tope), después se miran las fotos y al final se guardan las propuestas.
 */

export interface PhotoAi {
  /** El modelo que mira; null: la IA de fotos no está (sin clave). */
  model: ChatModel | null
  storage: Storage | null | undefined
  /** Cuántas fotos mira la IA por día y tienda. */
  capPerDay: number
}

/** Las fotos que mira la IA por día y tienda si no se dice otro tope (`GESTORIA_FOTOS_TOPE_DIA`). */
export const DEFAULT_PHOTOS_CAP = 200
/** Un «mirando» que pasó este tiempo ya no espera respuesta: se muestra como falló. */
const STALE_MS = 3 * 60_000
/** Lo que queda en el historial de la ficha cuando el cambio sale de una propuesta. */
export const FROM_AI = "Propuesta de la IA"

/* ------------------------------------------------------------------------------- el tope */

export type CapReason = "sin_ia" | "tope" | "saldo" | "sin_acceso"

const CAP_MESSAGES: Record<CapReason, (cap: number) => string> = {
  sin_ia: () => "La IA de fotos no está disponible ahora. Puedes cargar todo a mano.",
  tope: (cap) =>
    `Hoy la IA ya miró ${cap} fotos, el tope del día de tu tienda. Sigue cargando a mano: mañana vuelve.`,
  saldo: () =>
    "La IA de fotos se detuvo con Sofi: se acabó el saldo o se llegó al tope del plan. Sigue cargando a mano; vuelve en «Plan y pagos».",
  sin_acceso: () =>
    "Tu cuenta está en pausa: la IA de fotos no mira fotos. Puedes seguir cargando a mano.",
}

/** Lo que la IA ya miró hoy en la tienda (fotos; un texto cuenta como una) y si puede mirar más. */
export async function capIn(tx: Db, storeId: string, ai: PhotoAi, now = new Date()) {
  const { timeZone, today } = await storeClockIn(tx, storeId, now)
  const [row] = (await tx.execute<{ used: number }>(sql`
    select coalesce(sum(photos), 0)::int as used from ai_look
    where store_id = ${storeId} and requested_at >= ${startOfDay(timeZone, today).toISOString()}
      and (state <> 'fallo' or output_tokens > 0)`)) as unknown as [{ used: number }]
  const used = row.used
  const stop = await agentStopIn(tx, storeId)
  const reason: CapReason | null = !ai.model
    ? "sin_ia"
    : stop === "sin_acceso"
      ? "sin_acceso"
      : stop
        ? "saldo"
        : used >= ai.capPerDay
          ? "tope"
          : null
  return {
    available: reason === null,
    reason,
    used,
    cap: ai.capPerDay,
    left: Math.max(0, ai.capPerDay - used),
    message: reason ? CAP_MESSAGES[reason](ai.capPerDay) : null,
  }
}

export type CapState = Awaited<ReturnType<typeof capIn>>

/** El estado del tope para la pantalla (quien ve el catálogo). */
export async function aiCap(appDb: Db, person: Person, storeId: string, ai: PhotoAi) {
  return inStore(appDb, person, storeId, "catalogo.ver", (tx) => capIn(tx, storeId, ai))
}

/** Toma el tope de la tienda (uno a la vez) y devuelve cuántas fotos puede mirar ahora. */
async function reserveIn(tx: Db, storeId: string, ai: PhotoAi, wanted: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ia-fotos:${storeId}`}, 0))`)
  const cap = await capIn(tx, storeId, ai)
  if (!cap.available) throw new StoreError(409, "AI_UNAVAILABLE", cap.message!)
  return Math.min(wanted, cap.left)
}

/* -------------------------------------------------------------------------- las plantillas */

async function templatesIn(tx: Db, storeId: string) {
  const out = {} as Record<ProductRubro, TemplateField[]>
  for (const rubro of PRODUCT_RUBROS) out[rubro] = await templateIn(tx, storeId, rubro)
  return out
}

/* -------------------------------------------------------------------------- mirar las fotos */

interface PhotoKey {
  ref: string
  /** La carpeta en el almacenamiento; nula: la foto todavía está en la base (`content`). */
  objectKey: string | null
  content: Uint8Array | null
  contentType: string
}

/** Lee las fotos que va a mirar: la copia de la vitrina (o la miniatura, para juntarlas). */
async function readPhotos(
  storage: Storage | null | undefined,
  keys: PhotoKey[],
  copy: "vitrina" | "miniatura",
): Promise<PhotoIn[]> {
  const out: PhotoIn[] = []
  for (const key of keys) {
    if (key.objectKey && storage) {
      const bytes = await storage.get(`${key.objectKey}/${copy}`)
      if (bytes) out.push({ ref: key.ref, bytes, contentType: "image/webp" })
    } else if (key.content)
      out.push({ ref: key.ref, bytes: key.content, contentType: key.contentType })
  }
  return out
}

interface Begun {
  lookId: string
  photos: PhotoKey[]
}

/** Anota que la IA va a mirar (cuenta para el tope) y deja lo de antes que esperaba como descartado. */
async function beginLookIn(
  tx: Db,
  person: Person,
  storeId: string,
  ai: PhotoAi,
  kind: AiLookKind,
  target: { productId?: string; loadId?: string; itemId?: string },
  photos: PhotoKey[],
): Promise<Begun> {
  if (photos.length === 0)
    throw new StoreError(400, "NO_PHOTOS", "Sube al menos una foto para que la IA la mire")
  const room = await reserveIn(tx, storeId, ai, photos.length)
  const taken = photos.slice(0, room)
  const [row] = await tx
    .insert(aiLook)
    .values({
      storeId,
      kind,
      productId: target.productId ?? null,
      loadId: target.loadId ?? null,
      itemId: target.itemId ?? null,
      photos: taken.length,
      model: ai.model!.name,
      requestedBy: person.userId,
      requestedAt: sql`now()`,
    })
    .returning({ id: aiLook.id })
  return { lookId: row!.id, photos: taken }
}

/** Pedir otra vez reemplaza lo que esperaba del mismo producto: queda descartado por quien pide. */
async function supersedeIn(tx: Db, person: Person, where: ReturnType<typeof and>) {
  await tx
    .update(aiProposal)
    .set({ state: "descartada", decidedBy: person.userId, decidedAt: sql`now()` })
    .where(and(eq(aiProposal.state, "propuesta"), where))
}

/** Guarda el resultado de mirar: las propuestas y lo que usó, o el motivo si falló. */
async function finishLookIn(
  tx: Db,
  person: Person,
  storeId: string,
  lookId: string,
  target: { productId?: string; loadId?: string; itemId?: string },
  result: LookResult | LookFailure,
) {
  await closeLookIn(tx, person, storeId, lookId, target, result)
  await chargeLookIn(tx, storeId, lookId)
}

/** Lo que miró sale del saldo del plan: se le avisa a la administración en la misma transacción. */
async function chargeLookIn(tx: Db, storeId: string, lookId: string) {
  const [look] = await tx.select().from(aiLook).where(eq(aiLook.id, lookId))
  if (look && look.state !== "mirando") await countPhotoLook(tx, storeId, look)
}

async function closeLookIn(
  tx: Db,
  person: Person,
  storeId: string,
  lookId: string,
  target: { productId?: string; loadId?: string; itemId?: string },
  result: LookResult | LookFailure,
) {
  // Si mientras miraba se borró el producto o la carga, su `ai_look` se fue con él: no queda nada.
  const model = await lookModel(tx, lookId)
  if (model === undefined) return
  const usage = result.usage
  const done = {
    inputTokens: usage?.input ?? null,
    cachedTokens: usage?.cached ?? null,
    outputTokens: usage?.output ?? null,
    costMicros: usage ? costMicros(model, usage) : null,
    finishedAt: sql`now()`,
  }
  const fail = (message: string) =>
    tx
      .update(aiLook)
      .set({ state: "fallo", failure: message.slice(0, 300), ...done })
      .where(and(eq(aiLook.id, lookId), eq(aiLook.storeId, storeId)))
  if ("error" in result) return fail(result.error)
  // Mientras miraba, el producto de la carga pudo juntarse o quitarse, o la carga cerrarse.
  if (target.loadId) {
    const [load] = await tx
      .select({ state: bulkLoad.state })
      .from(bulkLoad)
      .where(and(eq(bulkLoad.id, target.loadId), eq(bulkLoad.storeId, storeId)))
    if (load?.state !== "abierta") return fail("La carga ya se creó o se descartó")
    if (target.itemId) {
      const [item] = await tx
        .select({ id: bulkLoadItem.id })
        .from(bulkLoadItem)
        .where(and(eq(bulkLoadItem.id, target.itemId), eq(bulkLoadItem.loadId, target.loadId)))
      if (!item) return fail("Ese producto ya no está en la carga")
    }
  }
  const scope = target.productId
    ? eq(aiProposal.productId, target.productId)
    : target.itemId
      ? and(eq(aiProposal.itemId, target.itemId), isNull(aiProposal.productId))
      : and(eq(aiProposal.loadId, target.loadId!), eq(aiProposal.field, "juntar"))
  await supersedeIn(tx, person, scope)
  if (result.proposals.length > 0)
    await tx.insert(aiProposal).values(
      result.proposals.map((p) => ({
        storeId,
        lookId,
        productId: target.productId ?? null,
        itemId: target.itemId ?? null,
        loadId: target.itemId ? null : (target.loadId ?? null),
        field: p.field,
        value: p.value,
        reason: p.reason,
        createdBy: person.userId,
        createdAt: sql`now()`,
      })),
    )
  await tx
    .update(aiLook)
    .set({ state: "lista", notice: result.notice?.slice(0, 300) ?? null, ...done })
    .where(and(eq(aiLook.id, lookId), eq(aiLook.storeId, storeId)))
}

async function lookModel(tx: Db, lookId: string) {
  const [row] = await tx.select({ model: aiLook.model }).from(aiLook).where(eq(aiLook.id, lookId))
  return row?.model
}

type LookFailure = { error: string; usage?: LookResult["usage"] }

/** Lo que se le dice a la persona cuando la IA no pudo mirar, con lo que usó si respondió. */
function failureOf(error: unknown): LookFailure {
  if (error instanceof LookError)
    return { error: error.message, ...(error.usage ? { usage: error.usage } : {}) }
  // Un error del proveedor, una espera vencida o la red: nunca se deja «mirando».
  if (!(error instanceof ModelError)) console.error("gestoria-api: la IA de fotos falló", error)
  return { error: "La IA no respondió. Prueba otra vez en un rato o sigue a mano." }
}

/** Mira con el modelo, fuera de toda transacción; un error queda dicho en palabras. */
async function runLook(fn: () => Promise<LookResult>): Promise<LookResult | LookFailure> {
  try {
    return await fn()
  } catch (error) {
    return failureOf(error)
  }
}

function failed(result: LookResult | LookFailure) {
  if ("error" in result) throw new StoreError(502, "AI_FAILED", result.error)
}

/** Mira las fotos de un producto y deja sus propuestas. */
export async function proposeForProduct(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
  ai: PhotoAi,
) {
  uuidOr404(productId, "Ese producto ya no está")
  const begun = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const row = await productRow(tx, storeId, productId)
    const photos = await tx
      .select({
        ref: productPhoto.id,
        objectKey: productPhoto.objectKey,
        content: productPhoto.content,
        contentType: productPhoto.contentType,
      })
      .from(productPhoto)
      .where(eq(productPhoto.productId, productId))
      .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
      .limit(MAX_LOOK_PHOTOS)
    const look = await beginLookIn(tx, person, storeId, ai, "producto", { productId }, photos)
    const detail = await detailIn(tx, storeId, productId)
    return {
      ...look,
      rubro: row.rubro,
      templates: await templatesIn(tx, storeId),
      current: {
        name: detail.name,
        category: detail.category,
        description: detail.description,
        rubroData: detail.rubroData,
        colors: detail.colors.map((c) => ({ value: c.value, hex: c.hex })),
        keywords: detail.keywords,
      },
    }
  })
  const result = await runLook(async () =>
    lookAtProduct(ai.model!, {
      photos: await readPhotos(ai.storage, begun.photos, "vitrina"),
      rubro: begun.rubro,
      templates: begun.templates,
      current: begun.current,
    }),
  )
  await inStore(appDb, person, storeId, "configuracion", (tx) =>
    finishLookIn(tx, person, storeId, begun.lookId, { productId }, result),
  )
  failed(result)
  return productProposals(appDb, person, storeId, productId, ai)
}

async function loadPhotoKeys(tx: Db, loadId: string, itemId: string | null) {
  return tx
    .select({
      ref: bulkLoadPhoto.id,
      objectKey: bulkLoadPhoto.objectKey,
      contentType: bulkLoadPhoto.contentType,
      itemId: bulkLoadPhoto.itemId,
    })
    .from(bulkLoadPhoto)
    .where(
      and(eq(bulkLoadPhoto.loadId, loadId), itemId ? eq(bulkLoadPhoto.itemId, itemId) : sql`true`),
    )
    .orderBy(asc(bulkLoadPhoto.position), asc(bulkLoadPhoto.createdAt))
}

/** Mira las fotos de un producto de una carga («Agregar desde fotos» es una carga de uno). */
export async function proposeForLoadItem(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  itemId: string,
  ai: PhotoAi,
) {
  const begun = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, storeId, loadId)
    const item = await itemRow(tx, loadId, itemId)
    const photos = (await loadPhotoKeys(tx, loadId, itemId))
      .slice(0, MAX_LOOK_PHOTOS)
      .map((p) => ({ ...p, content: null }))
    const look = await beginLookIn(
      tx,
      person,
      storeId,
      ai,
      "carga_producto",
      { loadId, itemId },
      photos,
    )
    return {
      ...look,
      templates: await templatesIn(tx, storeId),
      current: {
        name: item.name,
        category: item.category,
        description: item.description,
        colors: colorsOf(item.options).map((value) => ({ value, hex: null })),
      },
    }
  })
  const result = await runLook(async () =>
    lookAtProduct(ai.model!, {
      photos: await readPhotos(ai.storage, begun.photos, "vitrina"),
      rubro: null,
      templates: begun.templates,
      current: begun.current,
    }),
  )
  await inStore(appDb, person, storeId, "configuracion", (tx) =>
    finishLookIn(tx, person, storeId, begun.lookId, { loadId, itemId }, result),
  )
  failed(result)
  return loadProposals(appDb, person, storeId, loadId, ai)
}

/**
 * Mira las fotos sueltas de una carga (las que no tienen producto o están solas en uno sin nada
 * escrito) y propone cuáles juntar. Rosa confirma cada grupo.
 */
export async function proposeGroups(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  ai: PhotoAi,
) {
  const begun = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, storeId, loadId)
    const photos = await loadPhotoKeys(tx, loadId, null)
    const named = await tx
      .select({ id: bulkLoadItem.id })
      .from(bulkLoadItem)
      .where(and(eq(bulkLoadItem.loadId, loadId), ne(bulkLoadItem.name, "")))
    const count = new Map<string, number>()
    for (const p of photos) if (p.itemId) count.set(p.itemId, (count.get(p.itemId) ?? 0) + 1)
    const loose = photos
      .filter(
        (p) => !p.itemId || (count.get(p.itemId) === 1 && !named.some((n) => n.id === p.itemId)),
      )
      .slice(0, MAX_GROUP_PHOTOS)
      .map((p) => ({ ...p, content: null }))
    if (loose.length < 2)
      throw new StoreError(409, "NOTHING_TO_GROUP", "No hay fotos sueltas para juntar")
    return beginLookIn(tx, person, storeId, ai, "carga", { loadId }, loose)
  })
  const result = await runLook(async () =>
    groupLoosePhotos(ai.model!, await readPhotos(ai.storage, begun.photos, "miniatura")),
  )
  await inStore(appDb, person, storeId, "configuracion", (tx) =>
    finishLookIn(tx, person, storeId, begun.lookId, { loadId }, result),
  )
  failed(result)
  return loadProposals(appDb, person, storeId, loadId, ai)
}

export const rewriteInput = z.object({
  text: z.string().trim().min(3, "Escribe algo para mejorar").max(2000, "Máximo 2000 caracteres"),
})

/**
 * «Mejorar el texto» (tablero 12): reescribe lo que la persona escribió (la descripción, la
 * respuesta a lo que Sofi no supo) sin sumar datos. No se guarda: la persona lo usa si quiere,
 * con la operación de siempre. Cuenta como una foto para el tope.
 */
export async function improveText(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof rewriteInput>,
  ai: PhotoAi,
) {
  const begun = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const look = await beginLookIn(tx, person, storeId, ai, "texto", {}, [
      { ref: "texto", objectKey: null, content: null, contentType: "text/plain" },
    ])
    return { ...look, templates: await templatesIn(tx, storeId) }
  })
  let out: Awaited<ReturnType<typeof rewriteText>> | LookFailure
  try {
    out = await rewriteText(ai.model!, input.text, begun.templates)
  } catch (error) {
    out = failureOf(error)
  }
  await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const usage = out.usage
    await tx
      .update(aiLook)
      .set({
        state: "error" in out ? "fallo" : "lista",
        failure: "error" in out ? out.error : null,
        inputTokens: usage?.input ?? null,
        cachedTokens: usage?.cached ?? null,
        outputTokens: usage?.output ?? null,
        costMicros: usage ? costMicros(ai.model!.name, usage) : null,
        finishedAt: sql`now()`,
      })
      .where(eq(aiLook.id, begun.lookId))
    await chargeLookIn(tx, storeId, begun.lookId)
  })
  if ("error" in out) throw new StoreError(502, "AI_FAILED", out.error)
  // Si sumó un dato, no se propone: se dice, y el texto de la persona queda como estaba.
  return { text: out.text, unchanged: out.text === null, why: out.why }
}

/* ------------------------------------------------------------------------- verlas */

type ProposalRow = typeof aiProposal.$inferSelect

/** Lo que la persona ve de una propuesta: con quién la pidió y quién la decidió, por su nombre. */
async function viewsOf(tx: Db, rows: ProposalRow[], answered?: Record<string, unknown>) {
  const who = await namesOf(
    tx,
    rows.flatMap((r) => [r.createdBy, r.decidedBy]),
  )
  return rows
    .filter((r) => {
      // Una pregunta que ya tiene su dato en la ficha ya no se muestra.
      if (!answered || !r.field.startsWith("pregunta:")) return true
      return answered[r.field.slice("pregunta:".length)] === undefined
    })
    .map((r) => ({
      id: r.id,
      field: r.field,
      kind: r.field.startsWith("pregunta:")
        ? ("pregunta" as const)
        : r.field.startsWith("dato:")
          ? ("dato" as const)
          : (r.field as
              | "nombre"
              | "categoria"
              | "rubro"
              | "descripcion"
              | "palabras"
              | "color"
              | "juntar"),
      value: r.value,
      reason: r.reason,
      state: r.state,
      appliedValue: r.appliedValue,
      productId: r.productId,
      itemId: r.itemId,
      loadId: r.loadId,
      /** En un producto de una carga, lo que solo se usa en la ficha espera a «Crear». */
      waitsForProduct: !r.productId && !!r.itemId && !ITEM_FIELDS.has(r.field),
      createdBy: who.get(r.createdBy) ?? null,
      createdAt: r.createdAt,
      decidedBy: r.decidedBy ? (who.get(r.decidedBy) ?? null) : null,
      decidedAt: r.decidedAt,
    }))
}

/** La última vez que miró: su estado (un «mirando» viejo se muestra como falló) y su aviso. */
async function lastLookIn(tx: Db, where: ReturnType<typeof and>) {
  const [row] = await tx
    .select()
    .from(aiLook)
    .where(where)
    .orderBy(desc(aiLook.requestedAt))
    .limit(1)
  if (!row) return null
  const stale = row.state === "mirando" && Date.now() - row.requestedAt.getTime() > STALE_MS
  return {
    id: row.id,
    state: stale ? ("fallo" as const) : row.state,
    failure: stale ? "La IA no terminó de mirar. Prueba otra vez." : row.failure,
    notice: row.notice,
    photos: row.photos,
    requestedAt: row.requestedAt,
  }
}

/** Las propuestas de un producto: las que esperan y las últimas decididas, con el tope. */
export async function productProposals(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
  ai: PhotoAi,
) {
  uuidOr404(productId, "Ese producto ya no está")
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx, role) => {
    const row = await productRow(tx, storeId, productId)
    const rows = await tx
      .select()
      .from(aiProposal)
      .where(eq(aiProposal.productId, productId))
      .orderBy(desc(aiProposal.createdAt))
      .limit(100)
    const views = await viewsOf(tx, rows, row.rubroData)
    return {
      proposals: views.filter((v) => v.state === "propuesta"),
      decided: views.filter((v) => v.state !== "propuesta").slice(0, 30),
      look: await lastLookIn(tx, eq(aiLook.productId, productId)),
      cap: await capIn(tx, storeId, ai),
      /** Ventas y soporte ven lo propuesto; usarlo es de quien cambia el catálogo. */
      canDecide: can(role, "configuracion"),
    }
  })
}

/** Las propuestas de una carga: juntar fotos y las de cada producto de la carga. */
export async function loadProposals(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  ai: PhotoAi,
) {
  uuidOr404(loadId, "Esa carga ya no está")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const items = await tx
      .select({ id: bulkLoadItem.id })
      .from(bulkLoadItem)
      .where(and(eq(bulkLoadItem.loadId, loadId), eq(bulkLoadItem.storeId, storeId)))
    const ids = items.map((i) => i.id)
    const rows = await tx
      .select()
      .from(aiProposal)
      .where(
        and(
          eq(aiProposal.storeId, storeId),
          isNull(aiProposal.productId),
          or(
            eq(aiProposal.loadId, loadId),
            ids.length ? inArray(aiProposal.itemId, ids) : sql`false`,
          ),
        ),
      )
      .orderBy(desc(aiProposal.createdAt))
      .limit(1000)
    const views = await viewsOf(tx, rows)
    return {
      proposals: views.filter((v) => v.state === "propuesta"),
      look: await lastLookIn(tx, eq(aiLook.loadId, loadId)),
      cap: await capIn(tx, storeId, ai),
    }
  })
}

/* ------------------------------------------------------------------------- usarlas */

/** Lo que se usa ya en un producto de una carga; lo demás espera a la ficha. */
const ITEM_FIELDS = new Set(["nombre", "categoria", "descripcion", "color"])

const colorValue = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Escribe el color")
    .max(30, "Máximo 30 caracteres")
    .regex(/^[^,]*$/, "Un color no lleva comas"),
  hex: hexInput,
  hex2: hexInput.nullable().default(null),
  photos: z.array(z.uuid()).max(MAX_LOOK_PHOTOS).default([]),
})
const joinValue = z.object({ photos: z.array(z.uuid()).min(2).max(MAX_GROUP_PHOTOS) })

export const useInput = z.object({
  /** «Cambiar»: el valor que queda, en lugar del propuesto. En una pregunta, la respuesta. */
  value: z.unknown().optional(),
})

async function proposalRow(tx: Db, storeId: string, proposalId: string) {
  uuidOr404(proposalId, "Esa propuesta ya no está")
  const where = and(eq(aiProposal.id, proposalId), eq(aiProposal.storeId, storeId))
  const decided = new StoreError(409, "ALREADY_DECIDED", "Esa propuesta ya se usó o se descartó")
  const [row] = await tx.select().from(aiProposal).where(where)
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa propuesta ya no está")
  if (row.state !== "propuesta") throw decided
  // Una a la vez: la regla de la base solo deja tomar una que espera; si otra persona la decidió
  // recién, no vuelve ninguna.
  const [locked] = await tx.select().from(aiProposal).where(where).for("update")
  if (locked?.state !== "propuesta") throw decided
  return locked
}

async function decideIn(
  tx: Db,
  person: Person,
  row: ProposalRow,
  state: Exclude<AiProposalState, "propuesta">,
  applied: unknown = null,
) {
  await tx
    .update(aiProposal)
    .set({
      state,
      appliedValue: state === "cambiada" ? applied : null,
      decidedBy: person.userId,
      decidedAt: sql`now()`,
    })
    .where(eq(aiProposal.id, row.id))
}

type GridRow = NonNullable<GridInput["rows"]>["values"][number]

/** Aplica un color propuesto a la ficha: con «Tallas y stock» y las fotos de ese color. */
async function applyColorIn(
  tx: Db,
  person: Person,
  storeId: string,
  productId: string,
  color: z.infer<typeof colorValue>,
) {
  const detail = await detailIn(tx, storeId, productId)
  const rowLabel = detail.rubro ? RUBROS[detail.rubro].rowLabel : "Color"
  // El color es la opción del color, o la que se llama como él (la carga no lo marca).
  const colorIndex =
    detail.colorOption ??
    detail.options.findIndex((o) => sameText(o.name, rowLabel) || sameText(o.name, "Color"))
  if (colorIndex < 0 && detail.options.length >= 2)
    throw new StoreError(
      409,
      "TOO_MANY_OPTIONS",
      "Este producto ya tiene dos opciones y ninguna es el color: agrégalo en «Tallas y stock».",
    )
  const otherIndex = detail.options.findIndex((_, i) => i !== colorIndex)
  const other = otherIndex >= 0 ? detail.options[otherIndex]! : null
  if (colorIndex < 0 && detail.variants.some((v) => v.stock > 0))
    throw new StoreError(
      409,
      "HAS_STOCK",
      "Este producto ya tiene stock sin colores: agrega el color en «Tallas y stock».",
    )
  const photoIds = new Set(detail.photos.map((p) => p.id))
  const photos = color.photos.filter((id) => photoIds.has(id))
  const existing: GridRow[] =
    colorIndex >= 0
      ? detail.options[colorIndex]!.values.map((value) => {
          const look = detail.colors.find((c) => sameText(c.value, value))
          return {
            was: value,
            value,
            hex: look?.hex ?? null,
            hex2: look?.hex2 ?? null,
            photoId: look?.photoId ?? null,
          }
        })
      : []
  const at = existing.findIndex((c) => sameText(c.value, color.name))
  if (at >= 0)
    existing[at] = {
      ...existing[at]!,
      hex: color.hex,
      hex2: color.hex2,
      photoId: existing[at]!.photoId ?? photos[0] ?? null,
    }
  else
    existing.push({
      value: color.name,
      hex: color.hex,
      hex2: color.hex2,
      photoId: photos[0] ?? null,
    })
  const name = at >= 0 ? existing[at]!.value : color.name
  const rows = existing
  const valueAt = (variant: (typeof detail.variants)[number], index: number) =>
    index >= 0 ? (variant.optionValues[index] ?? null) : null
  const cells: GridInput["cells"] = []
  for (const r of rows)
    for (const column of other ? other.values : [null]) {
      // Sin color todavía, la talla de antes pasa al primer color con su código y su precio.
      const variant = detail.variants.find(
        (v) =>
          (colorIndex < 0 || sameText(valueAt(v, colorIndex) ?? "", r.value)) &&
          (column === null
            ? colorIndex >= 0 || v.optionValues.length === 0
            : sameText(valueAt(v, otherIndex) ?? "", column)),
      )
      cells.push({
        row: r.value,
        column,
        stock: variant?.stock ?? 0,
        priceCents: variant?.priceCents ?? null,
        barcode: variant?.barcode ?? null,
        ...(variant ? { sku: variant.sku } : {}),
      })
    }
  const grid: GridInput = {
    rows: {
      name: colorIndex >= 0 ? detail.options[colorIndex]!.name : rowLabel,
      values: rows,
    },
    columns: other
      ? { name: other.name, values: other.values.map((value) => ({ was: value, value })) }
      : null,
    cells,
    unitCostCents: null,
  }
  await saveGridIn(tx, person, storeId, productId, grid, FROM_AI)
  // Las demás fotos de ese color pasan a ser de ese color.
  const [look] = await tx
    .select({ id: productColor.id, value: productColor.value })
    .from(productColor)
    .where(eq(productColor.productId, productId))
    .then((list) => list.filter((l) => sameText(l.value, name)))
  if (look)
    for (const photoId of photos)
      await updatePhotoIn(tx, person, storeId, photoId, { colorId: look.id }, FROM_AI)
}

/** Usa una propuesta en un producto, por la operación de siempre de la ficha. */
async function useOnProductIn(
  tx: Db,
  person: Person,
  storeId: string,
  row: ProposalRow,
  value: unknown,
) {
  const productId = row.productId!
  const patchOf = (patch: unknown) => productPatch.parse(patch)
  const field = row.field
  if (field === "nombre")
    return updateProductIn(tx, person, storeId, productId, patchOf({ name: value }), FROM_AI)
  if (field === "categoria")
    return updateProductIn(tx, person, storeId, productId, patchOf({ category: value }), FROM_AI)
  if (field === "descripcion")
    return updateProductIn(tx, person, storeId, productId, patchOf({ description: value }), FROM_AI)
  if (field === "rubro")
    return updateProductIn(tx, person, storeId, productId, patchOf({ rubro: value }), FROM_AI)
  if (field === "palabras") {
    const current = await productRow(tx, storeId, productId)
    const words = z.array(z.string()).parse(value)
    const next = [
      ...current.keywords,
      ...words.filter((w) => !current.keywords.some((k) => sameText(k, w))),
    ]
    return updateProductIn(tx, person, storeId, productId, patchOf({ keywords: next }), FROM_AI)
  }
  if (field.startsWith("dato:") || field.startsWith("pregunta:")) {
    const key = field.slice(field.indexOf(":") + 1)
    if (
      field.startsWith("pregunta:") &&
      (value === null || value === undefined || (typeof value === "string" && !value.trim()))
    )
      throw new StoreError(400, "VALIDATION_ERROR", "Escribe la respuesta", {
        value: "Escribe la respuesta",
      })
    const current = await productRow(tx, storeId, productId)
    // Sin rubro, el dato va con el rubro que propuso la misma vez (y esa propuesta queda usada).
    let rubro: ProductRubro | undefined
    if (!current.rubro) {
      const [proposed] = await tx
        .select()
        .from(aiProposal)
        .where(
          and(
            eq(aiProposal.lookId, row.lookId),
            eq(aiProposal.field, "rubro"),
            eq(aiProposal.state, "propuesta"),
            eq(aiProposal.productId, productId),
          ),
        )
        .for("update")
      if (!proposed)
        throw new StoreError(409, "NO_RUBRO", "Elige primero el rubro del producto", {
          rubro: "Elige el rubro",
        })
      rubro = z.enum(PRODUCT_RUBROS).parse(proposed.value)
      await decideIn(tx, person, proposed, "usada")
    }
    return updateProductIn(
      tx,
      person,
      storeId,
      productId,
      patchOf({ ...(rubro ? { rubro } : {}), rubroData: { [key]: value } }),
      FROM_AI,
    )
  }
  if (field === "color") {
    await applyColorIn(tx, person, storeId, productId, colorValue.parse(value))
    return detailIn(tx, storeId, productId)
  }
  throw new StoreError(409, "NOT_FOR_PRODUCT", "Esta propuesta no se usa en la ficha")
}

/** Usa una propuesta en un producto de una carga o en la carga (juntar fotos). */
async function useOnLoadIn(
  tx: Db,
  person: Person,
  storeId: string,
  row: ProposalRow,
  value: unknown,
) {
  if (row.field === "juntar") {
    const { photos } = joinValue.parse(value)
    return joinPhotosIn(tx, storeId, row.loadId!, photos)
  }
  if (!ITEM_FIELDS.has(row.field))
    throw new StoreError(
      409,
      "WAITS_FOR_PRODUCT",
      "Esto se usa en la ficha: queda propuesto al crear el producto",
    )
  const [found] = await tx
    .select({ loadId: bulkLoadItem.loadId })
    .from(bulkLoadItem)
    .where(and(eq(bulkLoadItem.id, row.itemId!), eq(bulkLoadItem.storeId, storeId)))
  if (!found) throw new StoreError(404, "NOT_FOUND", "Ese producto ya no está en la carga")
  // Primero la carga tomada; después el producto, como en «Revisar» de siempre.
  await openLoadRow(tx, storeId, found.loadId)
  const item = await itemRow(tx, found.loadId, row.itemId!)
  const text = z.string().trim().min(1, "Escribe el valor")
  const colors = colorsOf(item.options)
  const patch = loadItemPatch.parse(
    row.field === "nombre"
      ? { name: text.parse(value) }
      : row.field === "categoria"
        ? { category: text.parse(value) }
        : row.field === "descripcion"
          ? { description: text.parse(value) }
          : (() => {
              const color = colorValue.parse(value)
              return colors.some((c) => sameText(c, color.name))
                ? {}
                : { colors: [...colors, color.name] }
            })(),
  )
  const [updated] = await tx
    .update(bulkLoadItem)
    .set(applyItem(item, patch))
    .where(eq(bulkLoadItem.id, item.id))
    .returning()
  return updated
}

/**
 * «Usar» (o «Cambiar», con otro valor) una propuesta: pasa por la operación de siempre y queda
 * decidida, a nombre de quien la usó. En una pregunta, el valor es la respuesta.
 */
export async function useProposal(
  appDb: Db,
  person: Person,
  storeId: string,
  proposalId: string,
  input: z.infer<typeof useInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx, role) => {
    const row = await proposalRow(tx, storeId, proposalId)
    const changed =
      input.value !== undefined && JSON.stringify(input.value) !== JSON.stringify(row.value)
    const value = changed ? input.value : row.value
    const result = row.productId
      ? forRole(await useOnProductIn(tx, person, storeId, row, value), role)
      : await useOnLoadIn(tx, person, storeId, row, value)
    await decideIn(tx, person, row, changed ? "cambiada" : "usada", value)
    return { result }
  })
}

/** «Descartar»: no cambia nada de la ficha; queda a nombre de quien la descartó. */
export async function discardProposal(
  appDb: Db,
  person: Person,
  storeId: string,
  proposalId: string,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const row = await proposalRow(tx, storeId, proposalId)
    await decideIn(tx, person, row, "descartada")
    return { id: row.id, state: "descartada" as const }
  })
}

/** El orden de «Aplicar todos»: el rubro antes que sus datos; los colores antes que las palabras. */
const APPLY_ORDER = ["rubro", "nombre", "categoria", "color", "dato", "palabras", "descripcion"]
const orderOf = (field: string) => APPLY_ORDER.indexOf(field.startsWith("dato:") ? "dato" : field)

/**
 * «Aplicar todos» de un producto o de un producto de una carga: usa cada propuesta que espera
 * (menos las preguntas, que se responden). Una que no se puede usar queda propuesta y se dice
 * por qué; las demás se usan igual.
 */
export async function applyAll(
  appDb: Db,
  person: Person,
  storeId: string,
  target: { productId: string } | { loadId: string; itemId: string },
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx, role) => {
    const where =
      "productId" in target
        ? (uuidOr404(target.productId, "Ese producto ya no está"),
          eq(aiProposal.productId, target.productId))
        : (uuidOr404(target.itemId, "Ese producto ya no está en la carga"),
          and(eq(aiProposal.itemId, target.itemId), isNull(aiProposal.productId)))
    const rows = (
      await tx
        .select()
        .from(aiProposal)
        .where(and(eq(aiProposal.storeId, storeId), eq(aiProposal.state, "propuesta"), where))
    )
      .filter((r) => !r.field.startsWith("pregunta:") && r.field !== "juntar")
      .filter((r) => r.productId || ITEM_FIELDS.has(r.field))
      .sort((a, b) => orderOf(a.field) - orderOf(b.field))
    const skipped: { id: string; field: string; message: string }[] = []
    let applied = 0
    for (const row of rows) {
      try {
        // Cada una en su propio punto de guardado: si falla, las demás siguen.
        await tx.transaction(async (sp) => {
          const [fresh] = await sp
            .select()
            .from(aiProposal)
            .where(eq(aiProposal.id, row.id))
            .for("update")
          if (fresh?.state !== "propuesta") return
          if (row.productId) await useOnProductIn(sp, person, storeId, fresh, fresh.value)
          else await useOnLoadIn(sp, person, storeId, fresh, fresh.value)
          await decideIn(sp, person, fresh, "usada")
          applied++
        })
      } catch (error) {
        if (!(error instanceof StoreError) && !(error instanceof z.ZodError)) throw error
        skipped.push({
          id: row.id,
          field: row.field,
          message:
            error instanceof StoreError ? error.message : (error.issues[0]?.message ?? "No vale"),
        })
      }
    }
    const product =
      "productId" in target ? forRole(await detailIn(tx, storeId, target.productId), role) : null
    return { applied, skipped, product }
  })
}

/* ---------------------------------------------------- de la carga al producto, al crearlo */

/**
 * Al crear el producto desde la carga (`createFromLoad`): lo que la IA propuso de ese producto y
 * espera pasa a la ficha, y los colores que se usaron en la carga llevan a la ficha su hex y sus
 * fotos (con el id nuevo de cada foto). Corre en la transacción de «Crear».
 */
export async function carryProposalsIn(
  tx: Db,
  storeId: string,
  itemId: string,
  productId: string,
  photoOf: Map<string, string>,
) {
  const newPhotos = (ids: string[]) =>
    ids.map((id) => photoOf.get(id)).filter((id): id is string => !!id)
  const open = await tx
    .select({ id: aiProposal.id, field: aiProposal.field, value: aiProposal.value })
    .from(aiProposal)
    .where(
      and(
        eq(aiProposal.storeId, storeId),
        eq(aiProposal.itemId, itemId),
        eq(aiProposal.state, "propuesta"),
      ),
    )
  for (const one of open) {
    // Las fotos de la carga pasan al producto con otro id: el color que espera las sigue.
    const color = one.field === "color" ? colorValue.safeParse(one.value) : null
    await tx
      .update(aiProposal)
      .set({
        productId,
        ...(color?.success
          ? { value: { ...color.data, photos: newPhotos(color.data.photos) } }
          : {}),
      })
      .where(eq(aiProposal.id, one.id))
  }
  const decided = await tx
    .select({
      value: aiProposal.value,
      applied: aiProposal.appliedValue,
      state: aiProposal.state,
      decidedAt: aiProposal.decidedAt,
    })
    .from(aiProposal)
    .where(
      and(
        eq(aiProposal.storeId, storeId),
        eq(aiProposal.itemId, itemId),
        eq(aiProposal.field, "color"),
        inArray(aiProposal.state, ["usada", "cambiada"]),
      ),
    )
    .orderBy(asc(aiProposal.decidedAt))
  // Un color se usó dos veces (se pidió otra vez): vale lo último que se decidió.
  const byName = new Map<string, z.infer<typeof colorValue>>()
  for (const one of decided) {
    const color = colorValue.safeParse(one.state === "cambiada" ? one.applied : one.value)
    if (color.success) byName.set(color.data.name.toLocaleLowerCase("es"), color.data)
  }
  const used = [...byName.values()]
  if (used.length === 0) return
  const [row] = await tx
    .select({ options: product.options })
    .from(product)
    .where(eq(product.id, productId))
  const index = row?.options.findIndex((o) => sameText(o.name, "Color")) ?? -1
  if (!row || index < 0) return
  const values = row.options[index]!.values
  await tx.update(product).set({ colorOption: index }).where(eq(product.id, productId))
  for (const color of used) {
    const value = values.find((v) => sameText(v, color.name))
    if (!value) continue
    const photos = newPhotos(color.photos)
    const [look] = await tx
      .insert(productColor)
      .values({
        storeId,
        productId,
        value,
        hex: color.hex,
        hex2: color.hex2,
        photoId: photos[0] ?? null,
      })
      .returning({ id: productColor.id })
    if (look && photos.length)
      await tx
        .update(productPhoto)
        .set({ colorId: look.id })
        .where(and(eq(productPhoto.productId, productId), inArray(productPhoto.id, photos)))
  }
}
