import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { getClinicBrandColor } from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

/**
 * Cómo se ve la clínica (ADR 0162): el color de su marca, para que su app y sus páginas
 * públicas (registro, su enlace, el portal, la reserva, el chat) salgan en su color desde
 * el primer pintado; y su nombre y producto, para la app instalada (su manifiesto). Son
 * datos públicos, se ven en cada página suya. Una dirección que no
 * es de una clínica responde igual que una clínica sin color: no dice cuáles existen.
 */
export function createPublicAppearanceRoute(deps: { db: Db }) {
  const app = new Hono()
  app.get("/:slug", async (c) => {
    // Al cambiar el color, la clínica lo ve en la siguiente página: nada lo guarda en caché.
    c.header("Cache-Control", "no-store")
    const slug = c.req.param("slug")
    const none = { brandColor: null, name: null, product: null }
    if (!/^[a-z0-9-]{1,63}$/.test(slug)) return c.json({ data: none })
    const [org] = await deps.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.slug, slug))
      .limit(1)
    if (!org) return c.json({ data: none })
    const data = await withOrgContext(deps.db, org.id, async (tx) => {
      const [profile] = await tx.select({ product: orgProfile.product }).from(orgProfile).where(eq(orgProfile.organizationId, org.id)).limit(1)
      return { brandColor: (await getClinicBrandColor(tx, org.id)).brandColor, name: org.name, product: profile?.product ?? "dental" }
    })
    return c.json({ data })
  })
  return app
}
