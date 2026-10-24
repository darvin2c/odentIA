import { clinicAppAliases } from "@odentia/clinic-app/vite"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { layout, physical, rootRoute } from "@tanstack/virtual-file-routes"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Las páginas comunes viven en @odentia/clinic-app (ADR 0085), una sola vez para
 * cada producto. La app pone su raíz (nombre, ícono y estilos) y sus propias
 * páginas dentro de la zona con sesión: las de `src/routes/dental`.
 */
const COMMON_ROUTES = "../../../../packages/clinic-app/src/routes"
const routes = rootRoute("__root.tsx", [
  physical("", `${COMMON_ROUTES}/public`),
  layout("_org", `${COMMON_ROUTES}/_org.tsx`, [physical("", `${COMMON_ROUTES}/_org`), physical("", "dental")]),
])

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: Boolean(process.env.PORT),
  },
  resolve: { alias: clinicAppAliases() },
  plugins: [tailwindcss(), tanstackStart({ router: { virtualRouteConfig: routes } }), viteReact()],
})
