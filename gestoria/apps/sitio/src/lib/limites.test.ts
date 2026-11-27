/**
 * La web de gestorIA no usa nada de las clínicas (ADR 0203). La prueba común de límites
 * (`gestoria-boundaries.test.ts`) no lee los `.astro`: esta mira lo que traen las páginas y piezas
 * de la web. Solo lo suyo, Astro y sus integraciones, lo de uso general (`shared/`) y las
 * librerías del movimiento del Inicio.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "..")
const ROOT = join(SRC, "..", "..", "..", "..")

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.(astro|ts|tsx|mjs|css)$/.test(entry.name) ? [path] : []
  })
}

const IMPORT = /(?:from\s+|\bimport\s*\(?\s*|@import\s+)["']([^"']+)["']/g
// Las librerías del movimiento del Inicio (web v4): GSAP con ScrollTrigger, Lenis y three.js.
const ALLOWED =
  /^(astro(:|\/|$)|@astrojs\/|@fontsource|@odentia\/(ui|ui-patterns)(\/|$)|react-dom\/server$|vitest$|node:|gsap(\/|$)|lenis$|three$)/

describe("la web de gestorIA no usa nada de las clínicas", () => {
  it("solo trae lo suyo, Astro y lo de uso general", () => {
    const found: string[] = []
    for (const file of files(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const target = match[1] ?? ""
        if (target.startsWith(".")) {
          const resolved = relative(ROOT, join(file, "..", target)).replaceAll("\\", "/")
          if (!resolved.startsWith("gestoria/apps/sitio/")) found.push(`${file} → ${target}`)
        } else if (!ALLOWED.test(target)) found.push(`${file} → ${target}`)
      }
    }
    expect(found).toEqual([])
  })
})
