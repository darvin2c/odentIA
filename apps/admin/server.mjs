// Sirve estáticos y SSR; la autorización vive en la API compartida.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "srvx/node"
import { serveStatic } from "srvx/static"
import { withHashedAssetCache } from "../../scripts/static-files.mjs"
import handler from "./dist/server/server.js"

const root = dirname(fileURLToPath(import.meta.url))
serve({
  port: Number(process.env.PORT) || 3000,
  gracefulShutdown: true,
  fetch: handler.fetch,
  middleware: [withHashedAssetCache(serveStatic({ dir: join(root, "dist/client") }))],
})
