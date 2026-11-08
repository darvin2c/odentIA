import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { getClinicBrandColor } from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

/**
 * Cómo se ve la clínica (ADR 0162): el color de su marca, para que su app y sus páginas
 * públicas (registro, su enlace, el portal, la reserva, el chat) salgan en su color desde
 * el primer pintado. Es un dato público, se ve en cada página suya. Una dirección que no
 * es de una clínica responde igual que una clínica sin color: no dice cuáles existen.
 */
export function createPublicAppearanceRoute(deps: { db: Db }) {
  const app = new Hono()
  app.get("/:slug", async (c) => {
    // Al cambiar el color, la clínica lo ve en la siguiente página: nada lo guarda en caché.
    c.header("Cache-Control", "no-store")
    const slug = c.req.param("slug")
    if (!/^[a-z0-9-]{1,63}$/.test(slug)) return c.json({ data: { brandColor: null } })
    const [org] = await deps.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, slug))
      .limit(1)
    const brandColor = org
      ? (await withOrgContext(deps.db, org.id, (tx) => getClinicBrandColor(tx, org.id))).brandColor
      : null
    return c.json({ data: { brandColor } })
  })
  return app
}
