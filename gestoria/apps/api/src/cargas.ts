import {
  type BulkVariant,
  bulkLoad,
  bulkLoadItem,
  bulkLoadPhoto,
  type Db,
  MAX_BULK_ITEMS,
  MAX_BULK_PHOTOS,
  MAX_PRODUCT_PHOTOS,
  type ProductOption,
  productPhoto,
  storeEvent,
} from "@gestoria/db"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import type { Storage } from "./archivos.js"
import { MAX_PRODUCTS, money, namesOf, productInput, uuidOr404 } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import {
  createPlanned,
  type PlannedProduct,
  planSheet,
  readSheetBytes,
  type SheetError,
  sheetContext,
  sheetNameKey,
} from "./hoja.js"
import { APP_LINK_SECONDS, MediaOff, storePhoto } from "./medios.js"
import { carryProposalsIn } from "./propuestas.js"
import { sameText } from "./texto.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * «Cargar muchos» (decisiones 3 y 4 del lienzo «La ficha del producto»): una carga por vez que
 * se abre, con sus fotos (ya en el almacenamiento), sus productos por revisar y las filas de la
 * hoja. Nada pasa al catálogo hasta «Crear», y «Crear» guarda todo o nada, con las mismas reglas
 * que «Subir una hoja» (`createPlanned` de `hoja.ts`). Todo es `configuracion`.
 *
 * Cada foto que llega es un producto nuevo, salvo que se diga a cuál va: juntar las fotos en
 * productos lo hace la persona («Juntar», «Mover a…») o lo propone la IA de fotos
 * (`propuestas.ts`, «juntar»), y la persona confirma cada grupo.
 */

const loadFolder = (storeId: string, loadId: string, photoId: string) =>
  `tiendas/${storeId}/cargas/${loadId}/fotos/${photoId}`

export async function openLoadRow(tx: Db, person: Person, storeId: string, loadId: string) {
  uuidOr404(loadId, "Esa carga ya no está")
  const where = and(eq(bulkLoad.id, loadId), eq(bulkLoad.storeId, storeId))
  const [row] = await tx.select().from(bulkLoad).where(where)
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa carga ya no está")
  // La carga es de la tienda: si la cerró otra persona del equipo, se dice quién.
  const closed = async (state: string, by: string | null) => {
    const name = by && by !== person.userId ? (await namesOf(tx, [by])).get(by) : null
    const who = name ?? (by && by !== person.userId ? "Otra persona del equipo" : null)
    return new StoreError(
      409,
      "LOAD_CLOSED",
      state === "creada"
        ? `${who ? `${who} ya pasó` : "Ya pasaste"} esta carga al catálogo: cambia cada producto en su página.`
        : `${who ? `${who} descartó` : "Descartaste"} esta carga. Abre otra para seguir.`,
    )
  }
  if (row.state !== "abierta") throw await closed(row.state, row.finishedBy)
  // Una a la vez: «Crear» no corre mientras otra persona cambia la carga. La regla de la base
  // solo deja tomar una carga abierta: si otra la cerró recién, no vuelve ninguna.
  const [locked] = await tx.select().from(bulkLoad).where(where).for("update")
  if (!locked) {
    const [now] = await tx
      .select({ state: bulkLoad.state, finishedBy: bulkLoad.finishedBy })
      .from(bulkLoad)
      .where(where)
    throw await closed(now?.state ?? "descartada", now?.finishedBy ?? null)
  }
  return locked
}

export async function itemRow(tx: Db, loadId: string, itemId: string) {
  uuidOr404(itemId, "Ese producto ya no está en la carga")
  const [row] = await tx
    .select()
    .from(bulkLoadItem)
    .where(and(eq(bulkLoadItem.id, itemId), eq(bulkLoadItem.loadId, loadId)))
  if (!row) throw new StoreError(404, "NOT_FOUND", "Ese producto ya no está en la carga")
  return row
}

async function newItem(
  tx: Db,
  storeId: string,
  loadId: string,
  values: Partial<typeof bulkLoadItem.$inferInsert> = {},
) {
  const [{ n, last }] = (await tx.execute<{ n: number; last: number }>(
    sql`select count(*)::int as n, coalesce(max(position), -1)::int as last from bulk_load_item where load_id = ${loadId}`,
  )) as unknown as [{ n: number; last: number }]
  if (n >= MAX_BULK_ITEMS)
    throw new StoreError(
      409,
      "TOO_MANY",
      `Hasta ${MAX_BULK_ITEMS} productos por carga: crea estos y abre otra`,
    )
  const [row] = await tx
    .insert(bulkLoadItem)
    .values({ storeId, loadId, position: last + 1, ...values })
    .returning()
  return row!
}

/** Abre una carga nueva. */
export async function openLoad(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .insert(bulkLoad)
      .values({ storeId, createdBy: person.userId })
      .returning({ id: bulkLoad.id, state: bulkLoad.state, createdAt: bulkLoad.createdAt })
    return row!
  })
}

/**
 * Las cargas de la tienda, las abiertas primero, con cuántos productos y fotos tiene cada una, y
 * quién la abrió: la carga es de la tienda, y la pantalla dice de quién es la que se abre.
 */
export async function storeLoads(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const rows = await tx.execute<{
      id: string
      state: string
      created_by: string
      created_at: string
      created_products: number | null
      items: number
      photos: number
    }>(sql`
      select l.id, l.state, l.created_by, l.created_at, l.created_products,
        (select count(*)::int from bulk_load_item i where i.load_id = l.id and i.state <> 'quitado') as items,
        (select count(*)::int from bulk_load_photo p where p.load_id = l.id) as photos
      from bulk_load l where l.store_id = ${storeId}
      order by (l.state = 'abierta') desc, l.created_at desc limit 30`)
    const who = await namesOf(
      tx,
      [...rows].map((r) => r.created_by),
    )
    return {
      loads: [...rows].map((r) => ({
        id: r.id,
        state: r.state,
        createdBy: r.created_by,
        createdByName: who.get(r.created_by) ?? null,
        createdAt: new Date(r.created_at).toISOString(),
        createdProducts: r.created_products,
        items: r.items,
        photos: r.photos,
      })),
    }
  })
}

export const colorsOf = (options: ProductOption[]) =>
  options.find((o) => sameText(o.name, "Color"))?.values ?? []
const sizesOf = (options: ProductOption[]) =>
  options.find((o) => sameText(o.name, "Talla"))?.values ?? []

/** Una carga con sus productos, sus fotos (con enlaces firmados) y sus números. */
export async function loadDetail(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  loadId: string,
) {
  uuidOr404(loadId, "Esa carga ya no está")
  const data = await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [load] = await tx
      .select()
      .from(bulkLoad)
      .where(and(eq(bulkLoad.id, loadId), eq(bulkLoad.storeId, storeId)))
    if (!load) throw new StoreError(404, "NOT_FOUND", "Esa carga ya no está")
    const items = await tx
      .select()
      .from(bulkLoadItem)
      .where(eq(bulkLoadItem.loadId, loadId))
      .orderBy(asc(bulkLoadItem.position))
    const photos = await tx
      .select()
      .from(bulkLoadPhoto)
      .where(eq(bulkLoadPhoto.loadId, loadId))
      .orderBy(asc(bulkLoadPhoto.position), asc(bulkLoadPhoto.createdAt))
    const who = await namesOf(tx, [load.createdBy])
    return { load, items, photos, createdByName: who.get(load.createdBy) ?? null }
  })
  const photoView = async (p: (typeof data.photos)[number]) => ({
    id: p.id,
    itemId: p.itemId,
    position: p.position,
    fileName: p.fileName,
    width: p.width,
    height: p.height,
    urls: storage
      ? {
          miniatura: await storage.signedUrl(`${p.objectKey}/miniatura`, APP_LINK_SECONDS),
          vitrina: await storage.signedUrl(`${p.objectKey}/vitrina`, APP_LINK_SECONDS),
        }
      : null,
  })
  const photos = await Promise.all(data.photos.map(photoView))
  const live = data.items.filter((i) => i.state !== "quitado")
  return {
    load: {
      id: data.load.id,
      state: data.load.state,
      createdBy: data.load.createdBy,
      createdByName: data.createdByName,
      createdAt: data.load.createdAt,
      createdProducts: data.load.createdProducts,
    },
    items: data.items.map((item) => ({
      id: item.id,
      position: item.position,
      state: item.state,
      name: item.name,
      category: item.category,
      description: item.description,
      listPriceCents: item.listPriceCents,
      options: item.options,
      colors: colorsOf(item.options),
      sizes: sizesOf(item.options),
      variants: item.variants,
      doubt: item.doubt,
      sheetRow: item.sheetRow,
      photos: photos.filter((p) => p.itemId === item.id),
    })),
    /** Las fotos que no van con ningún producto («Foto sin producto»). */
    loosePhotos: photos.filter((p) => !p.itemId),
    counts: {
      items: live.length,
      ready: live.filter((i) => i.state === "listo").length,
      doubts: live.filter((i) => i.doubt).length,
      withoutPrice: live.filter((i) => !i.listPriceCents).length,
    },
    expiresAt: new Date(Date.now() + APP_LINK_SECONDS * 1000).toISOString(),
  }
}

/**
 * Sube una foto a la carga. Sin producto (`item` vacío o «nuevo») arma un producto nuevo con
 * ella; con el id de uno, va con ese; con «suelta», queda sin producto.
 */
export async function addLoadPhoto(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  loadId: string,
  bytes: Uint8Array,
  options: { fileName: string; item: string | null },
) {
  if (!storage) throw new MediaOff()
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const [{ n }] = (await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from bulk_load_photo where load_id = ${loadId}`,
    )) as unknown as [{ n: number }]
    if (n >= MAX_BULK_PHOTOS)
      throw new StoreError(
        409,
        "TOO_MANY",
        `Hasta ${MAX_BULK_PHOTOS} fotos por carga: crea estas y abre otra`,
      )
    let itemId: string | null = null
    if (options.item && options.item !== "nuevo" && options.item !== "suelta")
      itemId = (await itemRow(tx, loadId, options.item)).id
    else if (options.item !== "suelta") itemId = (await newItem(tx, storeId, loadId)).id
    const id = crypto.randomUUID()
    const folder = loadFolder(storeId, loadId, id)
    const stored = await storePhoto(storage, folder, bytes)
    try {
      const [row] = await tx
        .insert(bulkLoadPhoto)
        .values({
          id,
          storeId,
          loadId,
          itemId,
          position: n,
          fileName: options.fileName.slice(0, 200),
          objectKey: folder,
          ...stored,
          createdBy: person.userId,
        })
        .returning({
          id: bulkLoadPhoto.id,
          itemId: bulkLoadPhoto.itemId,
          position: bulkLoadPhoto.position,
        })
      return row!
    } catch (error) {
      await storage.removeFolder(folder).catch(() => undefined)
      throw error
    }
  })
}

export const loadPhotoPatch = z.object({
  /** «Mover a…»: el producto de la carga (null: sin producto); con `newItem`, a uno nuevo. */
  itemId: z.uuid().nullable().optional(),
  newItem: z.boolean().optional(),
  position: z.number().int().min(0).max(MAX_BULK_PHOTOS).optional(),
})

/** «Mover a…» (o arrastrar) una foto a otro producto de la carga, a uno nuevo o a ninguno. */
export async function moveLoadPhoto(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  photoId: string,
  patch: z.infer<typeof loadPhotoPatch>,
) {
  uuidOr404(photoId, "Esa foto ya no está en la carga")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const [photo] = await tx
      .select()
      .from(bulkLoadPhoto)
      .where(and(eq(bulkLoadPhoto.id, photoId), eq(bulkLoadPhoto.loadId, loadId)))
    if (!photo) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está en la carga")
    let itemId = photo.itemId
    if (patch.newItem) itemId = (await newItem(tx, storeId, loadId)).id
    else if (patch.itemId !== undefined)
      itemId = patch.itemId ? (await itemRow(tx, loadId, patch.itemId)).id : null
    await tx
      .update(bulkLoadPhoto)
      .set({ itemId, position: patch.position ?? photo.position })
      .where(eq(bulkLoadPhoto.id, photoId))
    await dropEmptyItems(tx, loadId)
    return { id: photoId, itemId }
  })
}

/** Quita una foto de la carga (la base anota su carpeta para borrarla). */
export async function removeLoadPhoto(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  photoId: string,
) {
  uuidOr404(photoId, "Esa foto ya no está en la carga")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const [row] = await tx
      .delete(bulkLoadPhoto)
      .where(and(eq(bulkLoadPhoto.id, photoId), eq(bulkLoadPhoto.loadId, loadId)))
      .returning({ id: bulkLoadPhoto.id })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está en la carga")
    await dropEmptyItems(tx, loadId)
  })
}

/** Un producto armado solo con una foto que se fue, sin nada escrito, ya no es nada: se quita. */
async function dropEmptyItems(tx: Db, loadId: string) {
  await tx.execute(sql`
    delete from bulk_load_item i
    where i.load_id = ${loadId} and i.name = '' and i.list_price_cents is null
      and i.sheet_row is null and jsonb_array_length(i.variants) = 0
      and not exists (select 1 from bulk_load_photo p where p.item_id = i.id)`)
}

const sizeList = z
  .array(z.string().trim().min(1).max(30, "Una talla o un color tiene más de 30 caracteres"))
  .max(40)
  .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, "Hay valores repetidos")

const itemFields = {
  name: z.string().trim().max(120, "Máximo 120 caracteres"),
  category: z.string().trim().max(60, "Máximo 60 caracteres").nullable(),
  description: z.string().trim().max(2000, "Máximo 2000 caracteres"),
  listPriceCents: money.nullable(),
  /** Los colores y las tallas: arman las variantes (cada color con cada talla). */
  colors: sizeList,
  sizes: sizeList,
  /** El stock de cada variante («Stock por talla 2»). */
  stock: z.number().int().min(0).max(999_999),
  state: z.enum(["revisar", "listo", "quitado"]),
  doubt: z.string().trim().max(200).nullable(),
}

export const loadItemPatch = z.object(itemFields).partial()

export const loadBulkPatch = z.object({
  ids: z.array(z.uuid()).min(1, "Elige al menos un producto").max(MAX_BULK_ITEMS),
  set: z
    .object({
      category: itemFields.category,
      listPriceCents: itemFields.listPriceCents,
      sizes: itemFields.sizes,
      stock: itemFields.stock,
      state: itemFields.state,
    })
    .partial(),
})

/** Lo que cambia de un producto de la carga, con sus variantes armadas de nuevo si cambian colores o tallas. */
export function applyItem(
  item: typeof bulkLoadItem.$inferSelect,
  patch: z.infer<typeof loadItemPatch>,
): Partial<typeof bulkLoadItem.$inferInsert> {
  const out: Partial<typeof bulkLoadItem.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) out.name = patch.name
  if (patch.category !== undefined) out.category = patch.category || null
  if (patch.description !== undefined) out.description = patch.description
  if (patch.listPriceCents !== undefined) out.listPriceCents = patch.listPriceCents
  if (patch.state !== undefined) out.state = patch.state
  if (patch.doubt !== undefined) out.doubt = patch.doubt || null
  const reshape = patch.colors !== undefined || patch.sizes !== undefined
  if (reshape) {
    const other = item.options.filter(
      (o) => !sameText(o.name, "Color") && !sameText(o.name, "Talla"),
    )
    if (other.length > 0)
      throw new StoreError(
        400,
        "VALIDATION_ERROR",
        `«${item.name || "Este producto"}» tiene otras opciones (${other.map((o) => o.name).join(", ")}): cámbialas después de crearlo.`,
      )
    const colors = patch.colors ?? colorsOf(item.options)
    const sizes = patch.sizes ?? sizesOf(item.options)
    const options: ProductOption[] = [
      ...(colors.length ? [{ name: "Color", values: colors }] : []),
      ...(sizes.length ? [{ name: "Talla", values: sizes }] : []),
    ]
    const combos: string[][] =
      colors.length && sizes.length
        ? colors.flatMap((c) => sizes.map((s) => [c, s]))
        : (colors.length ? colors : sizes).map((v) => [v])
    if (combos.length > 200)
      throw new StoreError(400, "VALIDATION_ERROR", "Hasta 200 variantes por producto")
    // La variante de antes con los mismos valores, por el nombre de cada opción (la hoja pudo
    // traer la talla primero): conserva su stock, su código, su precio y su costo.
    const names = options.map((o) => o.name)
    const before = (values: string[]) =>
      item.variants.find(
        (v) =>
          v.values.length === values.length &&
          names.every((name, i) => {
            const at = item.options.findIndex((o) => sameText(o.name, name))
            return at >= 0 && sameText(v.values[at] ?? "", values[i]!)
          }),
      )
    out.options = options
    out.variants = combos.map((values) => {
      const was = before(values)
      return {
        values,
        stock: patch.stock ?? was?.stock ?? 0,
        sku: was?.sku ?? null,
        priceCents: was?.priceCents ?? null,
        costCents: was?.costCents ?? null,
      }
    })
  } else if (patch.stock !== undefined) {
    out.variants = (item.variants.length ? item.variants : [{ values: [], stock: 0 }]).map((v) => ({
      ...v,
      stock: patch.stock!,
    }))
  }
  return out
}

export async function updateLoadItem(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  itemId: string,
  patch: z.infer<typeof loadItemPatch>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const item = await itemRow(tx, loadId, itemId)
    const [row] = await tx
      .update(bulkLoadItem)
      .set(applyItem(item, patch))
      .where(eq(bulkLoadItem.id, itemId))
      .returning()
    return row!
  })
}

/** «Poner a los 20»: lo mismo a muchos productos de la carga a la vez. */
export async function updateLoadItems(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  input: z.infer<typeof loadBulkPatch>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const items = await tx
      .select()
      .from(bulkLoadItem)
      .where(and(eq(bulkLoadItem.loadId, loadId), inArray(bulkLoadItem.id, input.ids)))
    if (items.length !== new Set(input.ids).size)
      throw new StoreError(404, "NOT_FOUND", "Alguno de esos productos ya no está en la carga")
    for (const item of items)
      await tx
        .update(bulkLoadItem)
        .set(applyItem(item, input.set))
        .where(eq(bulkLoadItem.id, item.id))
    return { updated: items.length }
  })
}

/** «Juntar»: las fotos de los otros productos pasan a este, y los otros se quitan. */
export async function joinLoadItems(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  itemId: string,
  from: string[],
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const target = await itemRow(tx, loadId, itemId)
    const others = from.filter((id) => id !== itemId)
    for (const id of others) await itemRow(tx, loadId, id)
    if (others.length === 0) return { id: target.id }
    await tx
      .update(bulkLoadPhoto)
      .set({ itemId: target.id })
      .where(and(eq(bulkLoadPhoto.loadId, loadId), inArray(bulkLoadPhoto.itemId, others)))
    await tx
      .delete(bulkLoadItem)
      .where(and(eq(bulkLoadItem.loadId, loadId), inArray(bulkLoadItem.id, others)))
    return { id: target.id }
  })
}

/**
 * Junta fotos de la carga en un mismo producto, dentro de la transacción de quien llama (la
 * propuesta «juntar» de la IA): van al producto de la primera foto que ya tiene uno, o a uno
 * nuevo; los productos que quedan sin fotos y sin nada escrito se quitan.
 */
export async function joinPhotosIn(
  tx: Db,
  person: Person,
  storeId: string,
  loadId: string,
  photoIds: string[],
) {
  await openLoadRow(tx, person, storeId, loadId)
  const photos = photoIds.length
    ? await tx
        .select({ id: bulkLoadPhoto.id, itemId: bulkLoadPhoto.itemId })
        .from(bulkLoadPhoto)
        .where(and(eq(bulkLoadPhoto.loadId, loadId), inArray(bulkLoadPhoto.id, photoIds)))
    : []
  if (photos.length < 2)
    throw new StoreError(409, "NOT_FOUND", "Esas fotos ya no están juntas en la carga")
  const ordered = photoIds
    .map((id) => photos.find((p) => p.id === id))
    .filter((p): p is (typeof photos)[number] => !!p)
  const target = ordered.find((p) => p.itemId)?.itemId ?? (await newItem(tx, storeId, loadId)).id
  await tx
    .update(bulkLoadPhoto)
    .set({ itemId: target })
    .where(
      and(
        eq(bulkLoadPhoto.loadId, loadId),
        inArray(
          bulkLoadPhoto.id,
          ordered.map((p) => p.id),
        ),
      ),
    )
  await dropEmptyItems(tx, loadId)
  return { itemId: target }
}

/**
 * La hoja de la carga (CSV o Excel, tallas en filas o en columnas): cada producto de la hoja es un
 * producto de la carga, con sus variantes y su stock. Si la hoja trae la columna «Foto» con el
 * nombre del archivo, esas fotos de la carga pasan a su producto. Con un error, no se agrega nada.
 */
export async function loadSheet(
  appDb: Db,
  person: Person,
  storeId: string,
  loadId: string,
  bytes: Uint8Array,
) {
  const source = readSheetBytes(bytes)
  if (typeof source === "object" && !Array.isArray(source))
    return { added: 0, errors: [source] as SheetError[] }
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const { currency, names, skus } = await sheetContext(tx, storeId)
    // Los nombres de la carga también cuentan: dos productos no se llaman igual.
    const inLoad = await tx
      .select({ name: bulkLoadItem.name })
      .from(bulkLoadItem)
      .where(
        and(
          eq(bulkLoadItem.loadId, loadId),
          sql`${bulkLoadItem.name} <> ''`,
          sql`${bulkLoadItem.state} <> 'quitado'`,
        ),
      )
    for (const row of inLoad) names.add(row.name)
    const plan = planSheet(source, currency, names, skus, ["Foto"])
    if (plan.errors.length > 0 || plan.products.length === 0)
      return {
        added: 0,
        errors: plan.errors.length
          ? plan.errors
          : [{ row: 0, message: "La hoja está vacía: deja la cabecera y una fila por variante" }],
      }
    const photos = await tx
      .select({ id: bulkLoadPhoto.id, fileName: bulkLoadPhoto.fileName })
      .from(bulkLoadPhoto)
      .where(eq(bulkLoadPhoto.loadId, loadId))
    const byFile = new Map(photos.map((p) => [sheetNameKey(p.fileName), p.id]))
    for (const planned of plan.products) {
      const item = await newItem(tx, storeId, loadId, {
        name: planned.name,
        category: planned.category,
        description: planned.description,
        listPriceCents: planned.listPriceCents,
        options: planned.options,
        variants: planned.variants.map(
          (v): BulkVariant => ({
            values: v.values,
            stock: v.stock,
            sku: v.sku,
            priceCents: v.priceCents === planned.listPriceCents ? null : v.priceCents,
            costCents: v.costCents,
          }),
        ),
        sheetRow: planned.variants[0]?.row ?? null,
        state: "listo",
      })
      const ids = planned.photoFiles.flatMap((file) => {
        const id = byFile.get(sheetNameKey(file))
        return id ? [id] : []
      })
      if (ids.length)
        await tx
          .update(bulkLoadPhoto)
          .set({ itemId: item.id })
          .where(inArray(bulkLoadPhoto.id, ids))
    }
    await dropEmptyItems(tx, loadId)
    return { added: plan.products.length, errors: [] as SheetError[] }
  })
}

export interface LoadError {
  itemId: string
  message: string
}

/**
 * «Crear»: los productos de la carga que no se quitaron pasan al catálogo, con sus variantes, su
 * stock (entrada «Carga de muchos» en el kardex) y sus fotos, que no se copian: el producto usa
 * la misma carpeta. Todo o nada: con un error, no se crea ninguno y vuelve cada error con su
 * producto. Una duda no frena (decisión 2).
 */
export async function createFromLoad(appDb: Db, person: Person, storeId: string, loadId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    const items = (
      await tx
        .select()
        .from(bulkLoadItem)
        .where(eq(bulkLoadItem.loadId, loadId))
        .orderBy(asc(bulkLoadItem.position))
    ).filter((i) => i.state !== "quitado")
    const photos = await tx
      .select()
      .from(bulkLoadPhoto)
      .where(eq(bulkLoadPhoto.loadId, loadId))
      .orderBy(asc(bulkLoadPhoto.position), asc(bulkLoadPhoto.createdAt))
    const { names, skus } = await sheetContext(tx, storeId)
    const taken = new Set([...names].map(sheetNameKey))
    const errors: LoadError[] = []
    const planned: (PlannedProduct & { itemId: string })[] = []
    const sheetSkus = new Set<string>()
    for (const item of items) {
      const fail = (message: string) => errors.push({ itemId: item.id, message })
      const name = item.name.trim()
      if (!name) {
        fail("Ponle nombre")
        continue
      }
      if (taken.has(sheetNameKey(name))) {
        fail(`«${name}» ya está en tu catálogo o en otro producto de la carga`)
        continue
      }
      taken.add(sheetNameKey(name))
      if (!item.listPriceCents) {
        fail(`Ponle precio a «${name}»`)
        continue
      }
      const own = photos.filter((p) => p.itemId === item.id)
      if (own.length > MAX_PRODUCT_PHOTOS)
        fail(`«${name}» tiene ${own.length} fotos: hasta ${MAX_PRODUCT_PHOTOS} por producto`)
      const checked = productInput.safeParse({
        name,
        category: item.category,
        description: item.description,
        listPriceCents: item.listPriceCents,
        options: item.options,
      })
      if (!checked.success) {
        fail(`«${name}»: ${checked.error.issues[0]?.message ?? "revisa sus datos"}`)
        continue
      }
      const variants = item.variants.length ? item.variants : [{ values: [], stock: 0 }]
      if (variants.some((v) => v.values.length !== item.options.length)) {
        fail(`«${name}»: sus variantes no son de sus opciones`)
        continue
      }
      for (const v of variants)
        if (v.sku) {
          const key = v.sku.toLowerCase()
          if (skus.has(key) || sheetSkus.has(key)) fail(`El código «${v.sku}» ya se usa`)
          sheetSkus.add(key)
        }
      planned.push({
        itemId: item.id,
        photoFiles: [],
        name,
        category: item.category,
        description: item.description,
        options: item.options,
        listPriceCents: item.listPriceCents,
        variants: variants.map((v) => ({
          row: item.sheetRow ?? 0,
          values: v.values,
          sku: v.sku ?? null,
          priceCents: v.priceCents ?? item.listPriceCents!,
          stock: v.stock,
          costCents: v.costCents ?? null,
        })),
      })
    }
    if (items.length === 0) errors.push({ itemId: "", message: "La carga no tiene productos" })
    if (names.size + planned.length > MAX_PRODUCTS)
      errors.push({ itemId: "", message: `Tu catálogo pasaría de ${MAX_PRODUCTS} productos` })
    if (errors.length > 0) return { created: 0, errors }

    const idOf = await createPlanned(tx, storeId, person, planned, skus, "Carga de muchos")
    // Las fotos pasan al producto con su misma carpeta; las demás se borran (la base las anota).
    const moved = planned.flatMap((p) =>
      photos
        .filter((ph) => ph.itemId === p.itemId)
        .map((ph, position) => ({
          storeId,
          productId: idOf.get(sheetNameKey(p.name))!,
          position,
          contentType: ph.contentType,
          objectKey: ph.objectKey,
          sizeBytes: ph.sizeBytes,
          width: ph.width,
          height: ph.height,
          createdBy: person.userId,
        })),
    )
    const inserted =
      moved.length > 0
        ? await tx
            .insert(productPhoto)
            .values(moved)
            .returning({ id: productPhoto.id, objectKey: productPhoto.objectKey })
        : []
    // Lo que propuso la IA de cada producto de la carga pasa a su producto (`propuestas.ts`).
    const photoOf = new Map(
      photos.flatMap((ph) => {
        const to = inserted.find((row) => row.objectKey === ph.objectKey)
        return to ? [[ph.id, to.id] as const] : []
      }),
    )
    for (const p of planned)
      await carryProposalsIn(tx, storeId, p.itemId, idOf.get(sheetNameKey(p.name))!, photoOf)
    await tx.delete(bulkLoadPhoto).where(eq(bulkLoadPhoto.loadId, loadId))
    await tx
      .update(bulkLoad)
      .set({
        state: "creada",
        finishedBy: person.userId,
        finishedAt: sql`now()`,
        createdProducts: planned.length,
      })
      .where(eq(bulkLoad.id, loadId))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "catalogo.carga",
      detail: {
        carga: loadId,
        productos: planned.length,
        variantes: planned.reduce((n, p) => n + p.variants.length, 0),
        fotos: moved.length,
      },
    })
    return { created: planned.length, errors: [] as LoadError[], productIds: [...idOf.values()] }
  })
}

/** «Descartar»: la carga se cierra sin pasar nada al catálogo; sus fotos se borran. */
export async function discardLoad(appDb: Db, person: Person, storeId: string, loadId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await openLoadRow(tx, person, storeId, loadId)
    await tx.delete(bulkLoadPhoto).where(eq(bulkLoadPhoto.loadId, loadId))
    await tx
      .update(bulkLoad)
      .set({ state: "descartada", finishedBy: person.userId, finishedAt: sql`now()` })
      .where(eq(bulkLoad.id, loadId))
  })
}
