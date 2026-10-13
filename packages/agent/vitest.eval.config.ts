import { defineConfig } from "vitest/config"

// Mediciones con modelos reales (`pnpm eval:month`): no forman parte de `pnpm test`.
export default defineConfig({
  test: {
    include: ["src/**/*.eval.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    reporters: ["default"],
    disableConsoleIntercept: true,
  },
})
