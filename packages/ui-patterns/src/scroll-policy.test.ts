import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

/**
 * Regla de `packages/ui/AGENTS.md`: paneles, listas y columnas se desplazan con
 * `ScrollArea`, no con la barra del navegador (issue 100). Esta prueba busca
 * `overflow-*-auto` y `overflow-*-scroll` en las apps y en los patrones para que
 * la regla no dependa de que alguien la recuerde.
 *
 * Se aceptan dos casos: la fila que oculta su barra (`scrollbar-width:none`,
 * no se ve ninguna barra) y la excepción escrita en el código con un comentario
 * `scroll-nativo: <por qué>` en la misma línea o en las seis anteriores (la apertura de su etiqueta).
 */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..")
const SCANNED = ["apps/dental-clinic/src", "apps/panel/src", "apps/admin/src", "packages/ui-patterns/src"]
const NATIVE = /\boverflow(?:-[xy])?-(?:auto|scroll)\b/
const MARKER = "scroll-nativo:"

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Quita los comentarios conservando los saltos de línea, para no contar lo que solo se menciona. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

test("las zonas desplazables usan ScrollArea, salvo excepción escrita", () => {
  const offenders: string[] = []
  for (const dir of SCANNED) {
    for (const file of sources(join(ROOT, dir))) {
      const original = readFileSync(file, "utf8").split("\n")
      withoutComments(original.join("\n"))
        .split("\n")
        .forEach((line, index) => {
          if (!NATIVE.test(line) || line.includes("scrollbar-width:none")) return
          const context = original.slice(Math.max(0, index - 6), index + 1).join("\n")
          if (context.includes(MARKER)) return
          offenders.push(`${relative(ROOT, file).replaceAll("\\", "/")}:${index + 1}`)
        })
    }
  }
  expect(offenders).toEqual([])
})
