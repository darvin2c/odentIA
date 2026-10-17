// La web de marketing se genera por adelantado (HTML estático) para que los buscadores la lean entera.
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"

const LEGAL_EN_PREPARACION =
  /\/(terminos|privacidad|cookies|encargo-de-tratamiento|subencargados|aviso-legal|pe\/libro-de-reclamaciones)$/

const domain = process.env.VITE_BASE_DOMAIN || "odentia.localhost"
const port = process.env.VITE_BASE_PORT ? `:${process.env.VITE_BASE_PORT}` : ""
// En producción la web ocupa el dominio raíz (ADR 0046); en local la raíz es de la plataforma
// y la web va en www. No usar WEB_URL: es la dirección del panel (app.).
const host = domain.endsWith(".localhost") ? `www.${domain}` : domain

export default defineConfig({
  site: `https://${host}${port}`,
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  server: { port: Number(process.env.PORT) || 5176 },
  // Las islas del navegador también arman los enlaces al panel y el envío del Libro de
  // Reclamaciones; como en las demás apps, las VITE_* son públicas y llegan al navegador.
  vite: { envPrefix: ["PUBLIC_", "VITE_"] },
  // Las páginas legales quedan fuera del mapa mientras su texto esté en preparación (llevan noindex).
  integrations: [react(), sitemap({ filter: (page) => !LEGAL_EN_PREPARACION.test(page) })],
})
