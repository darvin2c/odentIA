// robots.txt: todo se puede leer (lo que no debe indexarse lleva noindex) y el mapa del sitio.
import type { APIRoute } from "astro"

export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap-index.xml", site)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
