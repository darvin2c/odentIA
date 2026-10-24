import { defineConfig } from "vitest/config"
import { clinicAppAliases } from "./vite"

export default defineConfig({
  resolve: { alias: clinicAppAliases() },
})
