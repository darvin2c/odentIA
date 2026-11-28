import { aiLook, aiProposal, type Db, product } from "@gestoria/db"
import { and, eq } from "drizzle-orm"

const OWNER = "semilla-rosa"

/**
 * Lo que la IA de fotos propuso para el Mocasín azul de Calzados Rosa, todavía sin usar: así la
 * ficha muestra sus ✦ (la descripción, las palabras y la pregunta por cómo calza). No llama a
 * ningún modelo: es la demo. Una vez sola por tienda.
 */
export async function seedDemoProposals(tx: Db, storeId: string): Promise<void> {
  const [already] = await tx
    .select({ id: aiLook.id })
    .from(aiLook)
    .where(eq(aiLook.storeId, storeId))
    .limit(1)
  if (already) return
  const [mocasin] = await tx
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.storeId, storeId), eq(product.name, "Mocasín azul")))
  if (!mocasin) return
  const at = new Date(Date.now() - 2 * 3_600_000)
  const [look] = await tx
    .insert(aiLook)
    .values({
      storeId,
      kind: "producto",
      productId: mocasin.id,
      photos: 1,
      state: "lista",
      model: "semilla",
      requestedBy: OWNER,
      requestedAt: at,
      finishedAt: at,
    })
    .returning({ id: aiLook.id })
  const proposal = (field: string, value: unknown, reason: string) => ({
    storeId,
    lookId: look!.id,
    productId: mocasin.id,
    field,
    value,
    reason,
    createdBy: OWNER,
    createdAt: at,
  })
  await tx
    .insert(aiProposal)
    .values([
      proposal(
        "descripcion",
        "Mocasín azul de punta redonda, sin pasadores, con costura a la vista en el empeine.",
        "Con lo que se ve en las fotos",
      ),
      proposal(
        "palabras",
        ["mocasín azul", "zapato sin pasadores", "mocasín"],
        "Lo que se ve en las fotos",
      ),
      proposal("pregunta:horma", null, "¿Cómo calza? No se ve en las fotos."),
    ])
}
