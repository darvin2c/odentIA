import { defineMiddleware } from "astro:middleware"
import type { APIContext, MiddlewareNext } from "astro"
import { loadPricing } from "./lib/pricing"
import { servesPage, WORDS } from "./lib/product"

/** Lo que dura una página armada en la caché de Cloudflare: lo mismo que los precios leídos. */
const EDGE_SECONDS = 30

/**
 * La caché del centro de datos de Cloudflare que atiende la visita; solo existe en Workers
 * (en Node, `pnpm dev` y el VPS, no hay `caches`). Es la API de caché y no la caché delante
 * del Worker: con esa, también cada archivo de la página contaría para el plan gratuito.
 */
function edgeCache(): Cache | undefined {
  return (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)?.default
}

/**
 * Antes de cada página: la web vive en el dominio raíz (ADR 0046), así que
 * www.<dominio> redirige ahí con la misma ruta (en local la web es www.), y
 * cada página recibe los precios de la administración en `Astro.locals`.
 *
 * En Workers (ADR 0136), la página armada se guarda 30 s: la visita que la
 * encuentra no la vuelve a armar ni gasta los 10 ms de CPU del plan gratuito, y
 * un precio cambiado se ve en un minuto como mucho. El 503 no se guarda: seguiría
 * diciendo «vuelve» con la API ya de vuelta.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const url = context.url
  if (url.hostname.startsWith("www.") && !url.hostname.endsWith(".localhost")) {
    const apex = new URL(url)
    apex.hostname = url.hostname.slice(4)
    apex.protocol = "https:"
    apex.port = ""
    return context.redirect(apex.toString(), 301)
  }
  const edge = context.request.method === "GET" ? edgeCache() : undefined
  const hit = await edge?.match(context.request)
  // Lo que sale de la caché no se puede modificar, y Astro le agrega cabeceras.
  if (hit) return new Response(hit.body, hit)
  const response = await render(context, next)
  if (
    edge &&
    (response.status === 200 || response.status === 404) &&
    !response.headers.has("Set-Cookie")
  ) {
    const copy = new Response(response.clone().body, response)
    copy.headers.set("Cache-Control", `s-maxage=${EDGE_SECONDS}`)
    const saving = edge.put(context.request, copy)
    const worker = (
      context.locals as { cfContext?: { waitUntil(promise: Promise<unknown>): void } }
    ).cfContext
    if (worker) worker.waitUntil(saving)
    else await saving
  }
  return response
})

/**
 * La web de latidIA sirve solo sus páginas (`servesPage`); lo demás no existe
 * ahí. Sin precios que mostrar (la API nunca respondió) se responde 503: mejor
 * «vuelve en un momento» que una cifra inventada.
 */
async function render(context: APIContext, next: MiddlewareNext): Promise<Response> {
  if (!servesPage(context.url.pathname)) {
    return new Response(`Esta página no existe en ${WORDS.name}.`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }
  try {
    context.locals.pricing = await loadPricing()
  } catch (error) {
    console.error("web: no se pudieron leer los precios", error)
    return new Response(`${WORDS.name} vuelve en un momento.`, {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30" },
    })
  }
  return next()
}
