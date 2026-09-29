import { organization } from "@odentia/db/schema/auth"
import type { Db } from "@odentia/db"
import { eq } from "drizzle-orm"

/** El origen WebAuthn nace de configuración del servidor, nunca de Origin/Host del cliente. */
export function portalOrigin(config: { webURL: string; cookieDomain: string }, slug: string): string {
  const url = new URL(config.webURL)
  const domain = config.cookieDomain.replace(/^\./, "")
  if (domain) url.hostname = `${slug}.${domain}`
  return url.origin
}

export async function portalOrganization(db: Db, slug: string) {
  const [org] = await db.select({ id: organization.id, slug: organization.slug, name: organization.name })
    .from(organization).where(eq(organization.slug, slug)).limit(1)
  return org ?? null
}
