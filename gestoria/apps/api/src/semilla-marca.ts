import { crc32, deflateSync } from "node:zlib"
import { type Db, store, storeImage, storeLink } from "@gestoria/db"
import { eq } from "drizzle-orm"
import { solidPng } from "./semilla-catalogo.js"

type Rgb = [number, number, number]

/**
 * El logo de ejemplo: un sello redondo de dos colores sobre fondo transparente (PNG RGBA), hecho
 * aquí para no guardar imágenes en el repositorio. Sus dos colores son los que «Tu marca» sugiere.
 */
export function badgePng(outer: Rgb, inner: Rgb, size = 640): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.writeUInt8(8, 8) // 8 bits por canal
  header.writeUInt8(6, 9) // RGBA
  const center = size / 2
  const rows = Array.from({ length: size }, (_, y) => {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - center, y + 0.5 - center) / center
      // Sello: borde de color, un anillo claro y el centro de color.
      const color = r > 1 ? null : r > 0.78 ? outer : r > 0.66 ? inner : r > 0.3 ? outer : inner
      if (color) row.set([...color, 255], 1 + x * 4)
    }
    return row
  })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * «Tu marca» de Calzados Rosa (tablero 04 del lienzo «gestorIA · Configuración, de nuevo»): su rosa, el nombre que
 * ve el cliente, el nombre de su link y un logo y una portada de un color, hechos aquí. Solo para
 * desarrollo y demostraciones, como el resto de `semilla.ts`. Si la tienda ya eligió su color, no
 * la toca.
 */
const OWNER = "semilla-rosa"

export async function seedDemoBrand(tx: Db, storeId: string): Promise<void> {
  const [row] = await tx
    .select({ brandColor: store.brandColor })
    .from(store)
    .where(eq(store.id, storeId))
  if (!row || row.brandColor) return
  await tx
    .update(store)
    .set({ publicName: "Calzados Rosa", brandColor: "#be185d" })
    .where(eq(store.id, storeId))
  await tx
    .insert(storeLink)
    .values({ name: "calzadosrosa", storeId, createdBy: OWNER })
    .onConflictDoNothing()
  await tx
    .insert(storeImage)
    .values([
      {
        storeId,
        kind: "logo",
        contentType: "image/png",
        content: badgePng([190, 24, 93], [251, 207, 232]),
        updatedBy: OWNER,
      },
      {
        storeId,
        kind: "portada",
        contentType: "image/png",
        content: solidPng([251, 207, 232], 640),
        updatedBy: OWNER,
      },
    ])
    .onConflictDoNothing()
}
