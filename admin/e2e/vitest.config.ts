import { defineConfig } from "vitest/config"

// Solo las pruebas puras de esta carpeta: los `.spec.ts` son de Playwright.
export default defineConfig({ test: { include: ["*.test.ts"] } })
