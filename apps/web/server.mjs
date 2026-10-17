// Servidor de producción: solo los archivos de dist/ (HTML generado al compilar, ADR 0046).
// /precios sirve precios.html y / sirve index.html; lo demás es 404.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "srvx/node"
import { serveStatic } from "srvx/static"

const root = dirname(fileURLToPath(import.meta.url))

// La web vive en el dominio raíz (ADR 0046): www.<dominio> redirige ahí con la misma ruta.
// En local la web es www.odentia.localhost, como en astro.config.mjs.
const wwwToApex = (req, next) => {
  const url = new URL(req.url)
  if (!url.hostname.startsWith("www.") || url.hostname.endsWith(".localhost")) return next()
  url.hostname = url.hostname.slice(4)
  url.protocol = "https:"
  url.port = ""
  return Response.redirect(url, 301)
}

// Lo de /_astro/ lleva el hash en el nombre: un cambio publica otro archivo.
const cacheAssets = async (req, next) => {
  const res = await next()
  if (res.ok && new URL(req.url).pathname.startsWith("/_astro/")) {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable")
  }
  return res
}

serve({
  port: Number(process.env.PORT) || 3000,
  gracefulShutdown: true,
  middleware: [wwwToApex, cacheAssets, serveStatic({ dir: join(root, "dist") })],
  fetch: () => new Response("Página no encontrada", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }),
})
