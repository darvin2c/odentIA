/**
 * Las pantallas comunes no dependen de lo dental (ADR 0079): le piden sus
 * partes al producto con `productUi()` (`product-ui.ts`). Lo dental de la app
 * vive en `components/dental`, `lib/dental` y `product/dental`, y solo
 * `router.tsx` lo conecta, al declarar el producto. Es la misma regla que
 * `packages/dental/src/boundaries.test.ts` fija para los paquetes y la API.
 * Un archivo común nuevo que lo necesite es una señal de que falta una parte
 * en `ProductUi`, no de agregarlo aquí.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "..")
const IMPORTS_DENTAL =
  /(from |import\()"(@odentia\/dental|@odentia\/[a-z-]+\/dental|\.{1,2}\/(?:[^"]*\/)?dental(?:\/[^"]*)?)"/

/** Lo que ya es del producto dental, y `router.tsx`, que lo declara. */
const DENTAL_INSIDE = ["components/dental/", "lib/dental/", "product/dental/", "router.tsx"]

/**
 * Páginas propias del producto dental: la hoja del odontograma. Con lo común
 * en su paquete (entrega 2) se quedan en la app de odentIA.
 */
const PRODUCT_PAGES = [
  "routes/_org/patients.$patientId.odontogram.$assessmentId.print.tsx",
  "routes/_org/patients.$patientId.odontogram.print.tsx",
]

/**
 * Las pruebas de lo común que usan lo dental como ejemplo: el visor de
 * tomografías se prueba con el fantasma de odentIA (`generateCbctPhantom`).
 * Solo pruebas, nunca código que corre.
 */
const STILL_COUPLED = ["lib/cbct-arch.test.ts", "lib/cbct-volume.test.ts"]

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

describe("límites entre las pantallas comunes y lo dental (ADR 0079)", () => {
  const coupled = filesUnder("")
    // Esta prueba nombra los imports dentales como ejemplos.
    .filter((file) => file !== "product/boundaries.test.ts")
    .filter((file) => !DENTAL_INSIDE.some((inside) => file.startsWith(inside)))
    .filter((file) => !PRODUCT_PAGES.includes(file))
    .filter((file) => IMPORTS_DENTAL.test(readFileSync(join(SRC, file), "utf8")))
    .map((file) => relative(SRC, join(SRC, file)).split("\\").join("/"))
    .sort()

  it("lo común solo importa lo dental donde aún falta separarlo", () => {
    const fresh = coupled.filter((file) => !STILL_COUPLED.includes(file))
    expect(fresh, "pantallas comunes nuevas que importan lo dental").toEqual([])
  })

  it("en la lista solo hay pruebas, nunca código que corre", () => {
    expect(STILL_COUPLED.filter((file) => !/.test.tsx?$/.test(file))).toEqual([])
  })

  it("la lista se achica: lo que ya no importa lo dental sale de ella", () => {
    const done = STILL_COUPLED.filter((file) => !coupled.includes(file))
    expect(done, "quitar de STILL_COUPLED").toEqual([])
  })

  it("la regla reconoce cada forma de importar lo dental", () => {
    for (const line of [
      'import { FDI_ADULT } from "@odentia/dental"',
      'import { x } from "../dental/tooth-selector"',
      'import { x } from "../../components/dental/odontograma-tab"',
      'import { x } from "../../lib/dental/odontogram"',
      'import { dentalUi } from "./product/dental"',
      'const m = await import("../dental/odontogram-studio")',
    ])
      expect(IMPORTS_DENTAL.test(line), line).toBe(true)
    expect(IMPORTS_DENTAL.test('import { x } from "../patient/dental-free"')).toBe(false)
    expect(IMPORTS_DENTAL.test('import { x } from "@odentia/clinical"')).toBe(false)
  })
})
