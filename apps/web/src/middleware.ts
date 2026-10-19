import { defineMiddleware } from "astro:middleware"
import { loadPricing } from "./lib/pricing"

/**
 * Antes de cada página: la web vive en el dominio raíz (ADR 0046), así que
 * www.<dominio> redirige ahí con la misma ruta (en local la web es www.), y
 * cada página recibe los precios de la administración en `Astro.locals`.
 * Sin precios que mostrar (la API nunca respondió) se responde 503: mejor
 * «vuelve en un momento» que una cifra inventada.
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
  try {
    context.locals.pricing = await loadPricing()
  } catch (error) {
    console.error("web: no se pudieron leer los precios", error)
    return new Response("odentIA vuelve en un momento.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30" },
    })
  }
  return next()
})
