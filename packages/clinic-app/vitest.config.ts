import { defineConfig } from "vitest/config"
import { clinicAppAliases } from "./vite"

export default defineConfig({
  resolve: { alias: clinicAppAliases() },
  // Las pruebas de pantalla que escriben, abren y cierran (fichas, subir archivos) tardan 4–5 s en
  // un equipo rápido; en el CI pasaban los 5 s de vitest y dejaban main sin desplegar (tras #741).
  test: { testTimeout: 20_000 },
})
