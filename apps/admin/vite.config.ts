import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// Con `WEB_TARGET=cloudflare` el build es para Cloudflare Workers (ADR 0137); sin él, el servidor de
// Node: el de `pnpm dev`, que llega a la API de portless, y el del VPS mientras siga de respaldo.
const workers = process.env.WEB_TARGET === "cloudflare"

/**
 * pdf.js dibuja los PDF de Documentos y de los informes en el navegador (ADR 0196): al armar la
 * página no se usa y no entra al paquete del servidor, que en Workers tiene tope de tamaño. Ahí
 * queda vacío, como en las apps de las clínicas (`clinicAppWorkerStubs`).
 */
function pdfjsOutOfServer(): Plugin {
  const empty = "\0pdfjs-vacio"
  return {
    name: "odentia:pdfjs-fuera-del-servidor",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "ssr",
    resolveId: (id) => (/pdfjs-dist/.test(id) ? empty : null),
    load: (id) => (id === empty ? "export default undefined" : null),
  }
}

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5175,
    strictPort: Boolean(process.env.PORT),
  },
  plugins: [
    pdfjsOutOfServer(),
    ...(workers ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
