import { readFile } from "node:fs/promises"
import {
  bulkLoad,
  bulkLoadItem,
  bulkLoadPhoto,
  type Db,
  product,
  productColor,
  productVideo,
} from "@gestoria/db"
import { and, eq } from "drizzle-orm"
import sharp from "sharp"
import { createS3Storage } from "./archivos.js"
import { moveStoredPhotos, storePhoto, videoFolder } from "./medios.js"
import { checkVideo } from "./video.js"

/**
 * Las fotos y el video de Calzados Rosa en el almacenamiento (ADR 0236): pasa al bucket las fotos
 * que la semilla dejó en la base (como en producción, con `moveStoredPhotos`) y le suma a la
 * zapatilla negra un video corto, «Puesta, caminando», listo para WhatsApp (H.264 Main sin cuadros
 * B, AAC, el índice al principio). Solo en desarrollo: sin `GESTORIA_S3_*` no hace nada.
 */
export async function seedDemoMedia(ownerDb: Db, storeId: string): Promise<string> {
  const env = process.env
  if (!env.GESTORIA_S3_ENDPOINT || !env.GESTORIA_S3_ACCESS_KEY || !env.GESTORIA_S3_SECRET_KEY)
    return "sin GESTORIA_S3_*: las fotos quedan en la base y no hay video"
  const storage = createS3Storage({
    endpoint: env.GESTORIA_S3_ENDPOINT,
    region: env.GESTORIA_S3_REGION || "us-east-1",
    accessKeyId: env.GESTORIA_S3_ACCESS_KEY,
    secretAccessKey: env.GESTORIA_S3_SECRET_KEY,
    bucket: env.GESTORIA_S3_BUCKET || "gestoria-medios",
  })
  await storage.ensureBucket()
  let moved = 0
  for (;;) {
    const run = await moveStoredPhotos(ownerDb, storage)
    moved += run.moved
    if (!run.more) break
  }

  const [zapatilla] = await ownerDb
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.storeId, storeId), eq(product.name, "Zapatilla urbana")))
  if (!zapatilla) return `${moved} foto(s) al almacenamiento; falta la zapatilla para el video`
  await seedDemoLoad(ownerDb, storage, storeId)
  const [negra] = await ownerDb
    .select({ id: productColor.id })
    .from(productColor)
    .where(and(eq(productColor.productId, zapatilla.id), eq(productColor.value, "negra")))
  const [has] = await ownerDb
    .select({ id: productVideo.id })
    .from(productVideo)
    .where(eq(productVideo.productId, zapatilla.id))
  if (has) return `${moved} foto(s) al almacenamiento; el video ya estaba`

  const video = new Uint8Array(
    await readFile(new URL("../semilla/video-calzado.mp4", import.meta.url)),
  )
  const checked = checkVideo(video)
  if (!checked.ok) throw new Error(`semilla: el video de ejemplo no sirve (${checked.message})`)
  const poster = await sharp({
    create: { width: 480, height: 480, channels: 3, background: { r: 31, g: 31, b: 31 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer()
  const id = crypto.randomUUID()
  const folder = videoFolder(storeId, zapatilla.id, id)
  await storage.put(`${folder}/video`, video, "video/mp4")
  await storage.put(`${folder}/poster`, new Uint8Array(poster), "image/jpeg")
  await ownerDb.insert(productVideo).values({
    id,
    storeId,
    productId: zapatilla.id,
    colorId: negra?.id ?? null,
    label: "Puesta, caminando",
    objectKey: folder,
    sizeBytes: video.length,
    durationMs: checked.facts.durationMs,
    width: checked.facts.width,
    height: checked.facts.height,
    createdBy: "semilla-rosa",
  })
  return `${moved} foto(s) al almacenamiento y el video de la zapatilla negra`
}

/**
 * Una carga de ejemplo abierta (tablero 7): tres fotos, una zapatilla lista para revisar con su
 * precio y sus tallas, un mocasín con una duda y una foto sin producto. Nada pasa al catálogo
 * hasta «Crear».
 */
async function seedDemoLoad(
  ownerDb: Db,
  storage: ReturnType<typeof createS3Storage>,
  storeId: string,
) {
  const [open] = await ownerDb
    .select({ id: bulkLoad.id })
    .from(bulkLoad)
    .where(and(eq(bulkLoad.storeId, storeId), eq(bulkLoad.state, "abierta")))
  if (open) return
  const [load] = await ownerDb
    .insert(bulkLoad)
    .values({ storeId, createdBy: "semilla-rosa" })
    .returning({ id: bulkLoad.id })
  const [plataforma, mocasin] = await ownerDb
    .insert(bulkLoadItem)
    .values([
      {
        storeId,
        loadId: load!.id,
        position: 0,
        state: "listo",
        name: "Zapatilla plataforma",
        category: "Zapatillas",
        listPriceCents: 12900,
        options: [
          { name: "Color", values: ["rosada"] },
          { name: "Talla", values: ["36", "37", "38"] },
        ],
        variants: ["36", "37", "38"].map((talla) => ({ values: ["rosada", talla], stock: 2 })),
      },
      {
        storeId,
        loadId: load!.id,
        position: 1,
        name: "Mocasín azul",
        category: "Mocasines",
        doubt: "¿Es el mismo que el mocasín celeste?",
      },
    ])
    .returning({ id: bulkLoadItem.id })
  const photos: [string, [number, number, number], string | null][] = [
    ["IMG_0412.jpg", [251, 207, 232], plataforma!.id],
    ["IMG_0413.jpg", [147, 197, 253], mocasin!.id],
    ["IMG_0414.jpg", [231, 216, 196], null],
  ]
  for (const [position, [fileName, [r, g, b], itemId]] of photos.entries()) {
    const bytes = new Uint8Array(
      await sharp({ create: { width: 800, height: 800, channels: 3, background: { r, g, b } } })
        .jpeg({ quality: 80 })
        .toBuffer(),
    )
    const id = crypto.randomUUID()
    const folder = `tiendas/${storeId}/cargas/${load!.id}/fotos/${id}`
    const stored = await storePhoto(storage, folder, bytes)
    await ownerDb.insert(bulkLoadPhoto).values({
      id,
      storeId,
      loadId: load!.id,
      itemId,
      position,
      fileName,
      objectKey: folder,
      ...stored,
      createdBy: "semilla-rosa",
    })
  }
}
