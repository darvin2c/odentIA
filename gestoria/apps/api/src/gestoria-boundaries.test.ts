/**
 * gestorIA está aparte de las clínicas (lienzo B, tablero 9; ADR 0203): ni gestorIA importa un
 * paquete o una carpeta de las clínicas o de la administración, ni ellas importan a gestorIA.
 * Lo único en común son las piezas de uso general (`shared/`), que se usan como bibliotecas, y
 * la cuenta, a la que gestorIA llega por HTTP (el token firmado y los avisos). Si una pieza de
 * las clínicas sirve a gestorIA, se mueve a `shared/` en su propio cambio.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..", "..")
const GESTORIA = join(ROOT, "gestoria")
const SHARED = join(ROOT, "shared", "packages")
/** Las carpetas de los otros sistemas: las clínicas, la administración y lo de uso general. */
const OTHERS = ["apps", "packages", "e2e", "admin", "shared", "scripts", "infra"].map((dir) =>
  join(ROOT, dir),
)

const SKIP = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".wrangler",
  "test-results",
  "playwright-report",
])

function filesUnder(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path, match)
    return match.test(entry.name) ? [path] : []
  })
}

const CODE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|css)$/
/** Lo que trae otro archivo: `from`, `import "…"`, `import()`, `require()` y, en CSS, `@import` y `@source`. */
const IMPORT =
  /(?:from\s+|\bimport\s*\(?\s*|require\s*\(\s*|@import\s+(?:url\()?|@source\s+)["']([^"']+)["']/g

function packageNames(dir: string): Set<string> {
  return new Set(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "package.json")))
      .map(
        (entry) =>
          JSON.parse(readFileSync(join(dir, entry.name, "package.json"), "utf8")).name as string,
      ),
  )
}

const rel = (path: string) => relative(ROOT, path).replaceAll("\\", "/")

describe("gestorIA y las clínicas no se conocen", () => {
  it("gestorIA solo importa lo suyo y lo de uso general", () => {
    const shared = packageNames(SHARED)
    expect(shared).toContain("@odentia/ui")
    const found: string[] = []
    for (const file of filesUnder(GESTORIA, CODE)) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(IMPORT)) {
        const target = match[1] ?? ""
        if (target.startsWith("@odentia/")) {
          const name = target.split("/").slice(0, 2).join("/")
          if (!shared.has(name)) found.push(`${rel(file)} → ${target}`)
        } else if (target.startsWith(".")) {
          const resolved = rel(join(file, "..", target))
          if (!resolved.startsWith("gestoria/") && !resolved.startsWith("shared/"))
            found.push(`${rel(file)} → ${target}`)
        }
      }
    }
    expect(
      found,
      "gestorIA no usa nada de las clínicas: lo de uso general va en shared/, en su propio cambio",
    ).toEqual([])
  })

  it("los paquetes de gestorIA no dependen de los de las clínicas", () => {
    const shared = packageNames(SHARED)
    const found: string[] = []
    for (const file of filesUnder(GESTORIA, /^package\.json$/)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (name.startsWith("@odentia/") && !shared.has(name)) found.push(`${rel(file)} → ${name}`)
      }
    }
    expect(found).toEqual([])
  })

  it("nada de las clínicas, la administración ni lo de uso general importa a gestorIA", () => {
    const found: string[] = []
    for (const dir of OTHERS) {
      for (const file of filesUnder(dir, CODE)) {
        const text = readFileSync(file, "utf8")
        for (const match of text.matchAll(IMPORT)) {
          const target = match[1] ?? ""
          if (target.startsWith("@gestoria/")) found.push(`${rel(file)} → ${target}`)
          else if (target.startsWith(".") && rel(join(file, "..", target)).startsWith("gestoria/"))
            found.push(`${rel(file)} → ${target}`)
        }
      }
      for (const file of filesUnder(dir, /^package\.json$/)) {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<
          string,
          Record<string, string> | undefined
        >
        for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
          if (name.startsWith("@gestoria/")) found.push(`${rel(file)} → ${name}`)
      }
    }
    expect(found).toEqual([])
  })
})
