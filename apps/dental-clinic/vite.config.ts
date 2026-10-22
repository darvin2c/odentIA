import { createRequire } from "node:module"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig, normalizePath } from "vite"

const require = createRequire(import.meta.url)

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: Boolean(process.env.PORT),
  },
  resolve: {
    alias: [
      {
        // El códec JPEG de 12 bits no exporta su `.wasm` (lib/dicom-codecs.ts).
        find: /^@cornerstonejs\/codec-libjpeg-turbo-12bit\/wasm(\?.*)?$/,
        replacement: `${normalizePath(
          path.join(
            path.dirname(require.resolve("@cornerstonejs/codec-libjpeg-turbo-12bit/wasmjs")),
            "libjpegturbo12wasm.wasm",
          ),
        )}$1`,
      },
    ],
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
