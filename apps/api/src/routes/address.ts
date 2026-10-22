import { type Db, withOrgContext } from "@odentia/db"
import { type AddressProvider, type AddressPurpose, resolveAddress, suggestAddresses } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

/** Quién sugiere direcciones (issue 36, ADR 0077): Google para la sede, Geoapify para la persona. */
export type AddressProviders = Partial<Record<AddressPurpose, AddressProvider | null>>

const purpose = z.enum(["sede", "paciente"])
const suggestBody = z.strictObject({ q: z.string().max(200), for: purpose, session: z.uuid() })
const placeBody = z.strictObject({ id: z.string().min(1).max(300), for: purpose, session: z.uuid() })

/**
 * Sugerencias de direcciones para quien escribe una: la sede, quien configura;
 * la de una persona, quien edita sus datos. Lo escrito solo viaja al proveedor;
 * la respuesta es la dirección común (ADR 0077) o, sin proveedor, nada.
 */
export function createAddressRoute(deps: { db: Db; providers: AddressProviders }) {
  const app = new Hono()
  const allowed = (role: Parameters<typeof canAccess>[0], what: AddressPurpose) =>
    what === "sede" ? canAccess(role, "settings.write") : canAccess(role, "patients.write") || canAccess(role, "crm.write")

  // Lo escrito va en el cuerpo: la dirección de una persona no queda en registros de acceso.
  app.post("/suggestions", async (c) => {
    const parsed = suggestBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { orgId, memberRole } = orgContextOf(c)
    if (!allowed(memberRole, parsed.data.for)) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para escribir esta dirección"), 403)
    }
    const { q, for: what, session } = parsed.data
    return runService(c, 200, () =>
      suggestAddresses((fn) => withOrgContext(deps.db, orgId, fn), orgId, deps.providers[what], what, { text: q, session }),
    )
  })

  // La dirección de la sugerencia elegida, cuando no vino con ella (Google).
  app.post("/place", async (c) => {
    const parsed = placeBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { orgId, memberRole } = orgContextOf(c)
    if (!allowed(memberRole, parsed.data.for)) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para escribir esta dirección"), 403)
    }
    const { id, for: what, session } = parsed.data
    return runService(c, 200, () =>
      resolveAddress((fn) => withOrgContext(deps.db, orgId, fn), orgId, deps.providers[what], what, { id, session }),
    )
  })
  return app
}
