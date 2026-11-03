// La caché del centro de datos de Cloudflare que atiende la visita (ADR 0136). Solo existe en
// Workers: en Node (`pnpm dev`, el VPS) no hay `caches` y todo sigue como antes. Es la API de
// caché y no la caché delante del Worker: con esa, cada archivo de la página contaría para el
// plan gratuito.

/** La caché, o nada fuera de Workers. */
export function edgeCache(): Cache | undefined {
  return (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)?.default
}

/** Lo que solo dice de dónde vino la visita (campañas, anuncios): la página es la misma. */
const TRACKING = /^(utm_.+|fbclid|gclid|gbraid|wbraid|msclkid|ttclid|igshid|mc_cid|mc_eid)$/i

/** La clave de una página: su dirección sin lo que no cambia lo que se arma. */
export function pageKey(url: URL): string {
  const key = new URL(url)
  for (const name of [...key.searchParams.keys()]) {
    if (TRACKING.test(name)) key.searchParams.delete(name)
  }
  return key.toString()
}
