// La web de marketing se arma en el servidor al servir cada página (ADR 0062): así los precios y
// el programa Fundadores salen de la administración y los buscadores siguen leyendo el HTML entero.
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import cloudflare from "@astrojs/cloudflare"
import node from "@astrojs/node"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"

// Las presentaciones (/presentacion y cada una debajo) son para mostrarlas o enviarlas, no para
// buscadores (llevan noindex).
const FUERA_DEL_MAPA = /\/presentacion(\/.*)?$/

// La web de latidIA la publica el mismo servidor con VITE_PRODUCT=medical: su dominio y solo sus
// páginas en el mapa del sitio (`src/lib/latidia-pages.json`); las propias de latidIA no van en el de odentIA.
// Los productos que tienen web y su dominio en local. Otro detiene el armado en vez de publicar en
// silencio la web de odentIA en su dominio (ADR 0164).
const LOCAL_DOMAINS = { dental: "odentia.localhost", medical: "latidia.localhost" }
const product = process.env.VITE_PRODUCT || "dental"
if (!Object.hasOwn(LOCAL_DOMAINS, product))
  throw new Error(`VITE_PRODUCT=${product}: esta web todavía no tiene las páginas de ese producto`)
const medical = product === "medical"
const domain = process.env.VITE_BASE_DOMAIN || LOCAL_DOMAINS[product]
const latidiaPages = JSON.parse(readFileSync(new URL("./src/lib/latidia-pages.json", import.meta.url), "utf8"))
const port = process.env.VITE_BASE_PORT ? `:${process.env.VITE_BASE_PORT}` : ""
// En producción la web ocupa el dominio raíz (ADR 0046); en local la raíz es de la plataforma
// y la web va en www. No usar WEB_URL: es la dirección del panel (app.).
const host = domain.endsWith(".localhost") ? `www.${domain}` : domain
const site = `https://${host}${port}`

// Con las páginas armadas al servirlas, el mapa del sitio no las descubre solo: se listan desde
// src/pages (un archivo, una dirección), sin la extensión y sin «/index».
const pagesDir = fileURLToPath(new URL("./src/pages", import.meta.url))
function pageFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? pageFiles(join(dir, entry.name)) : entry.name.endsWith(".astro") ? [join(dir, entry.name)] : [],
  )
}
const pages = pageFiles(pagesDir)
  .map((file) => `/${relative(pagesDir, file).replaceAll("\\", "/").replace(/\.astro$/, "").replace(/(^|\/)index$/, "")}`)
  .filter((path) => (medical ? latidiaPages.serves.includes(path) : !latidiaPages.own.includes(path)))
  .map((path) => new URL(path === "/" ? "/" : path, site).toString().replace(/\/$/, path === "/" ? "/" : ""))

// Las dos webs se publican en Cloudflare Workers (ADR 0136) con `WEB_TARGET=cloudflare`; sin él,
// el servidor de Node, solo para `pnpm dev`: así la web local llega a la API de portless.
const workers = process.env.WEB_TARGET === "cloudflare"

export default defineConfig({
  site,
  output: "server",
  // En Workers: sin sesiones (la web no las usa y pedirían KV) y sin transformar imágenes (solo
  // hay SVG; el servicio de imágenes de Cloudflare se cobra aparte). La caché de las páginas
  // la pone `src/middleware.ts`.
  adapter: workers ? cloudflare({ imageService: "passthrough" }) : node({ mode: "standalone" }),
  ...(workers && { session: false }),
  trailingSlash: "never",
  // Cada enlace interno se baja al pasar el puntero (o al tocarlo): al hacer clic la página ya está.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  server: { port: Number(process.env.PORT) || 5176 },
  // Las islas del navegador también arman los enlaces al panel y los envíos a la API; como en
  // las demás apps, las VITE_* son públicas y llegan al navegador.
  vite: { envPrefix: ["PUBLIC_", "VITE_"] },
  // Las páginas legales quedan fuera del mapa mientras su texto esté en preparación (llevan noindex).
  integrations: [
    react(),
    sitemap({
      customPages: pages,
      filter: (page) => {
        const path = page.replace(/\/$/, "")
        // Cada web, solo sus páginas: las demás responden 404 en su dominio.
        const clean = new URL(page).pathname.replace(/\/$/, "") || "/"
        const ours = medical ? latidiaPages.serves.includes(clean) : !latidiaPages.own.includes(clean)
        return ours && !FUERA_DEL_MAPA.test(path)
      },
    }),
  ],
})
