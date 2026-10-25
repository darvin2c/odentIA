// La web de marketing se arma en el servidor al servir cada página (ADR 0062): así los precios y
// el programa Fundadores salen de la administración y los buscadores siguen leyendo el HTML entero.
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import node from "@astrojs/node"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"

const LEGAL_EN_PREPARACION =
  /\/(terminos|privacidad|cookies|encargo-de-tratamiento|subencargados|aviso-legal)$/

// La presentación de Fundadores es para mostrarla o enviarla, no para buscadores (lleva noindex).
const FUERA_DEL_MAPA = /\/presentacion$/

// La web de latidIA la publica el mismo servidor con VITE_PRODUCT=medical: su dominio y solo sus
// páginas en el mapa del sitio (`src/lib/latidia-pages.json`); las propias de latidIA no van en el de odentIA.
const medical = process.env.VITE_PRODUCT === "medical"
const domain = process.env.VITE_BASE_DOMAIN || (medical ? "latidia.localhost" : "odentia.localhost")
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

export default defineConfig({
  site,
  output: "server",
  adapter: node({ mode: "standalone" }),
  trailingSlash: "never",
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
        return ours && !LEGAL_EN_PREPARACION.test(path) && !FUERA_DEL_MAPA.test(path)
      },
    }),
  ],
})
