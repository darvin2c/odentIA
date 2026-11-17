// robots.txt de cada web: todo se puede leer (las presentaciones se apartan con su noindex) y el mapa del
// sitio de su dominio, para que el buscador lo encuentre sin esperar a Search Console. Cloudflare le
// antepone sus «content signals».
import type { APIRoute } from "astro"

export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap-index.xml", site)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  })
