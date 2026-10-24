import type { ClinicalProduct } from "@odentia/clinical"

/**
 * Una instalación para los dos dominios (decisión 9 del lienzo del issue 229):
 * odentIA en el dominio de siempre (`COOKIE_DOMAIN`) y latidIA en el suyo
 * (`MEDICAL_DOMAIN`). Cada producto tiene sus clínicas (`<slug>.`), su panel
 * (`app.`) y su API (`api.`), con el esquema y el puerto de los de odentIA: lo
 * que cambia es solo el dominio. La administración de odentIA es una sola.
 */

const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const bare = (domain: string) => domain.trim().toLowerCase().replace(/^\./, "")

/**
 * Una dirección o un origen de un dominio, en otro: `https://app.odentia32.com`
 * → `https://app.latidia72.com`. Admite el comodín de los orígenes de confianza
 * (`https://*.odentia32.com`). Lo que no es de ese dominio queda igual.
 */
export function onDomain(address: string, from: string, to: string): string {
  const match = new RegExp(
    `^([a-z][a-z0-9+.-]*://)((?:[^/:]+\\.)?)${quote(bare(from))}(?=[:/]|$)`,
    "i",
  ).exec(address)
  if (!match) return address
  return `${match[1]}${match[2]}${bare(to)}${address.slice(match[0].length)}`
}

/** Si una dirección u origen es del dominio (el dominio mismo o un subdominio). */
export function isOnDomain(address: string, domain: string): boolean {
  return onDomain(address, domain, "x.invalid") !== address
}

/** El producto de un nombre de host por su dominio; null si no es de ninguno. */
export function productOfHost(
  hostname: string,
  domains: Partial<Record<ClinicalProduct, string>>,
): ClinicalProduct | null {
  const host = hostname.trim().toLowerCase().replace(/:\d+$/, "")
  // El dominio más largo primero: uno no puede ser parte de otro.
  const entries = Object.entries(domains)
    .filter((entry): entry is [ClinicalProduct, string] => Boolean(entry[1]))
    .sort(([, a], [, b]) => bare(b).length - bare(a).length)
  for (const [product, domain] of entries) {
    const base = bare(domain)
    if (host === base || host.endsWith(`.${base}`)) return product
  }
  return null
}

/**
 * Los orígenes de confianza de otro producto: los de odentIA que son de su
 * dominio, llevados al del producto. La administración no se copia: es solo
 * de odentIA.
 */
export function trustedOriginsOn(
  origins: readonly string[],
  from: string,
  to: string,
  except: readonly string[] = [],
): string[] {
  return origins
    .filter((origin) => isOnDomain(origin, from) && !except.includes(origin))
    .map((origin) => onDomain(origin, from, to))
}
