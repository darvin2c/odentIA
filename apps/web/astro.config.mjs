// La web de marketing se genera por adelantado (HTML estático) para que los buscadores la lean entera.
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"

const LEGAL_EN_PREPARACION =
  /\/(terminos|privacidad|cookies|encargo-de-tratamiento|subencargados|aviso-legal|pe\/libro-de-reclamaciones)$/

const domain = process.env.VITE_BASE_DOMAIN || "odentia.localhost"

export default defineConfig({
  site: process.env.WEB_URL || `https://www.${domain}`,
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  server: { port: Number(process.env.PORT) || 5176 },
  // Las páginas legales quedan fuera del mapa mientras su texto esté en preparación (llevan noindex).
  integrations: [react(), sitemap({ filter: (page) => !LEGAL_EN_PREPARACION.test(page) })],
})
