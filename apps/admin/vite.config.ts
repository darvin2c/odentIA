import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5175,
    strictPort: Boolean(process.env.PORT),
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
