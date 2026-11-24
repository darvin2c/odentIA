// La web de marketing se arma en el servidor al servir cada página (ADR 0062): así los precios y
// el programa Fundadores salen de la administración y los buscadores siguen leyendo el HTML entero.
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import cloudflare from "@astrojs/cloudflare"
import node from "@astrojs/node"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"

// Las presentaciones (/presentacion y cada una debajo) son para mostrarlas o enviarlas, no para
// buscadores (llevan noindex), y tampoco la página de «no existe».
const FUERA_DEL_MAPA = /\/(presentacion(\/.*)?|404)$/

// Cada producto con web la publica el mismo servidor con su VITE_PRODUCT: su dominio y solo sus
// páginas en el mapa del sitio (`src/lib/product-pages.json`, las mismas que sirve `servesPage` en
// src/lib/product.ts); las propias de cada una no van en el de odentIA, el producto base.
// Los productos que tienen web y su dominio en local. Otro detiene el armado en vez de publicar en
// silencio la web de odentIA en su dominio (ADR 0168).
const BASE_PRODUCT = "dental"
const LOCAL_DOMAINS = { dental: "odentia.localhost", medical: "latidia.localhost", optical: "vistia.localhost" }
const product = process.env.VITE_PRODUCT || BASE_PRODUCT
if (!Object.hasOwn(LOCAL_DOMAINS, product))
  throw new Error(`VITE_PRODUCT=${product}: esta web todavía no tiene las páginas de ese producto`)
const domain = process.env.VITE_BASE_DOMAIN || LOCAL_DOMAINS[product]
const productPages = JSON.parse(readFileSync(new URL("./src/lib/product-pages.json", import.meta.url), "utf8"))
// Cada producto que no es el base dice sus páginas: sin ellas, el armado se detiene.
for (const known of Object.keys(LOCAL_DOMAINS))
  if (known !== BASE_PRODUCT && !Object.hasOwn(productPages, known))
    throw new Error(`src/lib/product-pages.json: faltan las páginas de ${known}`)
const ownOfOthers = Object.values(productPages).flatMap((pages) => pages.own)
/** ¿Es una página de esta web? La base, todas menos las propias de las demás; las otras, solo las suyas. */
const ours = (path) => (product === BASE_PRODUCT ? !ownOfOthers.includes(path) : productPages[product].serves.includes(path))
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
  .filter(ours)
  .map((path) => new URL(path === "/" ? "/" : path, site).toString().replace(/\/$/, path === "/" ? "/" : ""))

// La fecha de cada guía (ADR 0214): la de su archivo (`updated: "AAAA-MM-DD"` en src/lib/guides),
// la misma que dice la página y sus datos para Google. El índice lleva la más nueva.
const guidesDir = fileURLToPath(new URL("./src/lib/guides", import.meta.url))
const guideDates = new Map(
  readdirSync(guidesDir)
    .filter((name) => name.endsWith(".ts") && !["index.ts", "types.ts", "rich.ts"].includes(name) && !name.endsWith(".test.ts"))
    .flatMap((name) => {
      const text = readFileSync(join(guidesDir, name), "utf8")
      const slug = text.match(/slug:\s*"([a-z0-9-]+)"/)?.[1]
      const updated = text.match(/updated:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1]
      return slug && updated ? [[`/guias/${slug}`, updated]] : []
    }),
)
if (guideDates.size > 0) guideDates.set("/guias", [...guideDates.values()].sort().at(-1))

// La última vez que cambió la web (el último commit que tocó apps/web): el buscador vuelve a pasar
// cuando cambia. Sin git (un armado fuera del repositorio), el mapa va sin fecha.
let lastmod
try {
  const date = execFileSync("git", ["log", "-1", "--format=%cI", "--", "."], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
  }).trim()
  if (date) lastmod = new Date(date)
} catch {}

// Las webs se publican en Cloudflare Workers (ADR 0136) con `WEB_TARGET=cloudflare`; sin él,
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
      ...(lastmod && { lastmod }),
      filter: (page) => {
        const path = page.replace(/\/$/, "")
        // Cada web, solo sus páginas: las demás responden 404 en su dominio.
        const clean = new URL(page).pathname.replace(/\/$/, "") || "/"
        return ours(clean) && !FUERA_DEL_MAPA.test(path)
      },
      // Una guía lleva su propia fecha, no la del último cambio de la web.
      serialize: (item) => {
        const updated = guideDates.get(new URL(item.url).pathname.replace(/\/$/, ""))
        return updated ? { ...item, lastmod: new Date(`${updated}T12:00:00Z`).toISOString() } : item
      },
    }),
  ],
})
