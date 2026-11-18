/**
 * Un cambio solo de la administración corre el proyecto `admin` de Playwright (lienzo A,
 * paso 0). Para que no se salte nada, todo recorrido de las clínicas que abre una pantalla
 * de la administración debe estar en `ALSO_ADMIN` de `e2e/playwright.config.ts`, y nada
 * de esa lista puede sobrar. Se lee el archivo como texto: importarlo exige el entorno de
 * una corrida.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const E2E = join(import.meta.dirname, "..", "..", "e2e")
/** Lo que delata que un recorrido abre la administración. */
const OPENS_ADMIN = /hostUrl\("admin"|\bADMIN\b|\benterAdmin\b|from "\.\/admin"/

function listed(): string[] {
  const config = readFileSync(join(E2E, "playwright.config.ts"), "utf8")
  const block = config.match(/export const ALSO_ADMIN = \[([\s\S]*?)\]/)?.[1] ?? ""
  return [...block.matchAll(/"\*\*\/e2e\/([^"]+)"/g)].map((m) => m[1] ?? "").sort()
}

describe("los recorridos que corre un cambio solo de la administración", () => {
  it("ALSO_ADMIN trae exactamente los recorridos de las clínicas que abren la administración", () => {
    const opening = readdirSync(E2E)
      .filter((name) => name.endsWith(".spec.ts"))
      .filter((name) => OPENS_ADMIN.test(readFileSync(join(E2E, name), "utf8")))
      .sort()
    expect(opening.length).toBeGreaterThan(0)
    expect(listed(), "Suma o quita el recorrido en ALSO_ADMIN de e2e/playwright.config.ts").toEqual(opening)
  })
})
