import tailwindcss from "@tailwindcss/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * La app de gestorIA: una página que corre toda en el navegador (sin servidor propio), publicada
 * como archivos en Cloudflare Workers (`wrangler.jsonc`, ADR 0203). Habla con la cuenta
 * (`VITE_ACCOUNT_URL`) para entrar y con el servidor de gestorIA (`VITE_API_URL`) para lo demás.
 */
export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5181,
    strictPort: Boolean(process.env.PORT),
  },
  plugins: [tailwindcss(), viteReact()],
})
