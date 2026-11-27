import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * El prototipo de la ficha del producto (lienzo de gestorIA): una entrada aparte, con datos en
 * memoria y los mismos componentes, tema y letra de la app. No toca las pantallas reales ni el API.
 * `pnpm --filter @gestoria/web prototipo` lo abre; `build:prototipo` lo deja en `dist-prototipo/`,
 * con rutas relativas para publicarlo como archivos sueltos.
 */
const here = import.meta.dirname
const shared = path.join(here, "../../../shared/packages")

export default defineConfig({
  root: path.join(here, "prototipo"),
  base: "./",
  publicDir: path.join(here, "prototipo/public"),
  plugins: [tailwindcss(), viteReact()],
  resolve: {
    // La tabla de los patrones (`DataTable`) recibe la instancia de TanStack Table: la misma copia.
    alias: {
      "@tanstack/react-table": path.join(shared, "ui-patterns/node_modules/@tanstack/react-table"),
    },
  },
  build: {
    outDir: path.join(here, "dist-prototipo"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: { port: Number(process.env.PORT) || 5182 },
})
