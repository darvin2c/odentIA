import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Arranque del contenedor de PostgreSQL y las migraciones.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
