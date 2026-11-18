/**
 * Lo de uso general (`shared/`) no conoce a ningún sistema (lienzo A, paso 0): las
 * clínicas, la administración y gestorIA lo usan, pero ninguna pieza de `shared/`
 * importa a uno de ellos. Si lo hiciera, cambiar ese sistema podría romper a los demás.
 * Solo puede importar otras piezas de `shared/` y paquetes de fuera del repositorio.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..", "..")
const SHARED = join(ROOT, "shared", "packages")

/** Los nombres de los paquetes de `shared/`, leídos de su `package.json`. */
function sharedNames(): Set<string> {
  return new Set(
    readdirSync(SHARED, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(SHARED, entry.name, "package.json")))
      .map((entry) => JSON.parse(readFileSync(join(SHARED, entry.name, "package.json"), "utf8")).name as string),
  )
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|css)$/.test(entry.name) ? [path] : []
  })
}

/**
 * Lo que trae otro archivo: `from`, `import "…"` suelto, `import()`, `require()` y, en CSS,
 * `@import` y `@source` (Tailwind lee las clases de esa carpeta).
 */
const IMPORT = /(?:from\s+|\bimport\s*\(?\s*|require\s*\(\s*|@import\s+(?:url\()?|@source\s+)["']([^"']+)["']/g

describe("lo de uso general no conoce a ningún sistema", () => {
  it("ninguna pieza de shared importa un paquete o una carpeta de un sistema", () => {
    const allowed = sharedNames()
    expect(allowed).toContain("@odentia/channels")
    const found: string[] = []
    for (const file of filesUnder(SHARED)) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(IMPORT)) {
        const target = match[1] ?? ""
        const path = relative(ROOT, file).replaceAll("\\", "/")
        if (target.startsWith("@odentia/")) {
          const name = target.split("/").slice(0, 2).join("/")
          if (!allowed.has(name)) found.push(`${path} → ${target}`)
        } else if (target.startsWith(".")) {
          const resolved = relative(ROOT, join(file, "..", target)).replaceAll("\\", "/")
          if (!resolved.startsWith("shared/") && !resolved.startsWith("assets/")) found.push(`${path} → ${target}`)
        }
      }
    }
    expect(found, "Lo de shared/ solo usa shared/: mueve lo que necesite aquí o recíbelo como parámetro").toEqual([])
  })
})
