// La web pública de gestorIA (lienzo B8): páginas armadas una vez al publicar, HTML entero para los
// buscadores y sin código de servidor. Se publica como solo archivos en el Worker `gestoria-sitio`.
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"
import { hasPending, PRIVACIDAD, TERMINOS } from "./src/lib/legal"
import { SITE_URL } from "./src/lib/sitio"

// Términos y Privacidad quedan fuera del mapa mientras su texto conserve marcas (llevan noindex).
const fueraDelMapa = new Set(
  [TERMINOS, PRIVACIDAD].filter(hasPending).map((doc) => new URL(doc.path, SITE_URL).toString()),
)

export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "never",
  // /terminos → terminos.html: el Worker de archivos lo sirve en /terminos, sin barra al final.
  build: { format: "file" },
  // El WhatsApp de ventas llega al armado como `VITE_SALES_WHATSAPP`.
  vite: { envPrefix: ["PUBLIC_", "VITE_"] },
  integrations: [sitemap({ filter: (page) => !fueraDelMapa.has(page.replace(/\/$/, "")) })],
})
