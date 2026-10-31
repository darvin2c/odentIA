import { authClient } from "./auth-client"
import type { SessionInfo } from "./guards"
import type { ssrFetchOptions } from "./guards"

/**
 * Formato regional de la clínica, conocido antes del primer render para que
 * ninguna fecha se pinte con otro formato. Sin perfil: `undefined`, el formato
 * del navegador.
 */
export interface OrgRegion {
  locale: string | undefined
  timeZone: string | undefined
  country: string | undefined
  /** El producto de la clínica: si no es el de esta app, se abre en su dominio. */
  product?: string | undefined
  /** La clínica pide verificación en dos pasos (ADR 0107): activarla, o el código de esta sesión. */
  twoFactorRequired?: "activar" | "codigo"
}

export function readOrganization(slug: string, fetchOptions: ReturnType<typeof ssrFetchOptions>) {
  return authClient.organization.getFullOrganization({ query: { organizationSlug: slug }, fetchOptions })
}
export type FullOrganization = NonNullable<Awaited<ReturnType<typeof readOrganization>>["data"]>

export interface OrgAccess {
  slug: string
  at: number
  session: SessionInfo
  org: FullOrganization
}

/**
 * Lo ya comprobado en este navegador. Vive aquí y no en `_org.tsx` porque el
 * router parte esa ruta en dos módulos (`beforeLoad` y la pantalla), cada uno
 * con su copia de lo que declare: la pantalla no podría dejarle nada al otro.
 */
export const orgChecks: { access: OrgAccess | null; region: OrgRegion | null } = { access: null, region: null }

/**
 * Lo comprobado en el servidor al armar la página vale también en el navegador:
 * sin esto, el primer clic tras cargar repetía sesión, términos, clínica y perfil.
 */
export function rememberServerChecks(checked: { session: SessionInfo; org: FullOrganization; region: OrgRegion }): void {
  if (typeof window === "undefined" || checked.region.twoFactorRequired) return
  orgChecks.access ??= { slug: checked.org.slug, at: Date.now(), session: checked.session, org: checked.org }
  if (checked.region.timeZone) orgChecks.region ??= checked.region
}
