/**
 * El logo de la web es el de la marca común (`Brand` de `@odentia/ui-patterns`, marca «gestoria»),
 * guardado como archivo: la web se arma sin React y sin las piezas de la app. Si la marca común
 * cambia, esta prueba falla; `ACTUALIZAR_MARCA=1 pnpm --filter @gestoria/sitio test` lo vuelve a
 * escribir.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { Brand } from "@odentia/ui-patterns/src/brand"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

const ASSETS = new URL("../assets/", import.meta.url)

/** El SVG de la marca común, sin las clases de Tailwind de la app: aquí el tamaño lo pone la web. */
function render(compact: boolean): string {
  const svg = renderToStaticMarkup(<Brand brand="gestoria" compact={compact} />)
  return `${svg.replace(/ class="[^"]*"/, "")}\n`
}

describe("el logo de la web es el de la marca común", () => {
  for (const [file, compact] of [
    ["logotipo.svg", false],
    ["isotipo.svg", true],
  ] as const) {
    it(file, () => {
      const path = new URL(file, ASSETS)
      const expected = render(compact)
      if (process.env.ACTUALIZAR_MARCA === "1") writeFileSync(path, expected)
      // En Windows el checkout puede traer CRLF.
      expect(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).toBe(expected)
    })
  }
})
