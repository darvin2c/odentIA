import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Con `WEB_TARGET=cloudflare` el build es para Cloudflare Workers (ADR 0137); sin él, el servidor de
// Node, solo para `pnpm dev`: así llega a la API de portless.
const workers = process.env.WEB_TARGET === "cloudflare"

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: Boolean(process.env.PORT),
  },
  plugins: [
    ...(workers ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
