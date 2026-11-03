import { cloudflare } from "@cloudflare/vite-plugin"
import { clinicAppAliases, clinicAppWorkerStubs } from "@odentia/clinic-app/vite"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { layout, physical, rootRoute } from "@tanstack/virtual-file-routes"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Las páginas comunes viven en @odentia/clinic-app (ADR 0086), una sola vez para
 * cada producto. La app pone su raíz (nombre, ícono y estilos) y sus propias
 * páginas dentro de la zona con sesión: las de `src/routes/dental`.
 */
const COMMON_ROUTES = "../../../../packages/clinic-app/src/routes"
const routes = rootRoute("__root.tsx", [
  physical("", `${COMMON_ROUTES}/public`),
  layout("_org", `${COMMON_ROUTES}/_org.tsx`, [physical("", `${COMMON_ROUTES}/_org`), physical("", "dental")]),
])

// Con `WEB_TARGET=cloudflare` el build es para Cloudflare Workers (ADR 0138); sin él, el servidor de
// Node: el de `pnpm dev`, que llega a la API de portless, y el del VPS mientras siga de respaldo.
const workers = process.env.WEB_TARGET === "cloudflare"

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: Boolean(process.env.PORT),
  },
  // `chat.js` del chat web (ADR 0076) es común a los productos: vive en el paquete.
  publicDir: "../../packages/clinic-app/public",
  resolve: { alias: clinicAppAliases() },
  plugins: [
    ...(workers ? [cloudflare({ viteEnvironment: { name: "ssr" } }), clinicAppWorkerStubs()] : []),
    tailwindcss(),
    tanstackStart({ router: { virtualRouteConfig: routes } }),
    viteReact(),
  ],
})
