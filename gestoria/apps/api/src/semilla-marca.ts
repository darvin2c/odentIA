import { type Db, store, storeImage, storeLink } from "@gestoria/db"
import { eq } from "drizzle-orm"
import { solidPng } from "./semilla-catalogo.js"

/**
 * «Tu marca» de Calzados Rosa (lienzo «gestorIA como odentIA», tablero 10): su rosa, el nombre que
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
        content: solidPng([190, 24, 93], 160),
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
