import { clinicAppAliases } from "@odentia/clinic-app/vite"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { layout, physical, rootRoute } from "@tanstack/virtual-file-routes"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * La app de latidIA (issue 229): las páginas comunes de @odentia/clinic-app
 * (ADR 0086) con su raíz (nombre, ícono y color). Aún no tiene páginas propias.
 */
const COMMON_ROUTES = "../../../../packages/clinic-app/src/routes"
const routes = rootRoute("__root.tsx", [
  physical("", `${COMMON_ROUTES}/public`),
  layout("_org", `${COMMON_ROUTES}/_org.tsx`, [physical("", `${COMMON_ROUTES}/_org`)]),
])

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5174,
    strictPort: Boolean(process.env.PORT),
  },
  // `chat.js` del chat web (ADR 0076) es común a los productos: vive en el paquete.
  publicDir: "../../packages/clinic-app/public",
  resolve: { alias: clinicAppAliases() },
  plugins: [tailwindcss(), tanstackStart({ router: { virtualRouteConfig: routes } }), viteReact()],
})
