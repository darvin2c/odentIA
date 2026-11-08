/**
 * Lo común nunca compara productos ni marcas a mano (`product === "medical" ?
 * … : …`): un producto nuevo caería en silencio en la rama de otro (sus
 * palabras, su marca, su dominio, sus mensajes). Decide con un mapa completo por
 * producto (`Record<ClinicalProduct, …>`) o por marca, así el compilador señala
 * cada lugar que tiene que decir algo del nuevo. Lo que es del producto base
 * (odentIA: el dominio de la plataforma, el remitente de siempre) se compara con
 * `BASE_PRODUCT` o `BASE_MAIL_BRAND`, nunca con su nombre escrito.
 *
 * Quedan fuera las carpetas y apps de cada producto, que sí se nombran a sí
 * mismas, las pruebas, las stories, las mediciones (eligen la clínica de la
 * semilla de cada producto) y la web de marketing, que se arma aparte para cada
 * producto y detiene el armado ante uno que no conoce (`apps/web/src/lib/product.ts`).
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..")

/** Carpetas comunes: el código que corre para todos los productos. */
const COMMON = [
  "packages/clinical/src",
  "packages/services/src",
  "packages/db/src",
  "packages/agent/src",
  "packages/auth/src",
  "packages/channels/src",
  "packages/mail/src",
  "packages/ui/src",
  "packages/ui-patterns/src",
  "packages/clinic-app/src",
  "apps/api/src",
  "apps/worker/src",
  "apps/panel/src",
  "apps/admin/src",
]

/** Lo que es de un producto dentro de lo común: ahí sí se nombra. */
const PRODUCT_INSIDE = /\/(dental|medical)\//

/** Pruebas, stories y mediciones: no corren para una clínica. */
const NOT_RUNTIME =
  /\.(test|spec|stories)\.tsx?$|\.eval\.ts$|\/(auditoria-[^/]*|eval[^/]*|help-measure|help-guide-suite)\.ts$|\/routeTree\.gen\.ts$/

const NAMES = "dental|medical|odentia|latidia"
const COMPARES = new RegExp(
  `(===|!==)\\s*["'](${NAMES})["']|["'](${NAMES})["']\\s*(===|!==)|\\bcase\\s+["'](${NAMES})["']\\s*:`,
)

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

describe("lo común decide por producto con un mapa completo", () => {
  it("ningún código común compara un producto o una marca con su nombre escrito", () => {
    const found: string[] = []
    for (const dir of COMMON) {
      for (const file of filesUnder(join(ROOT, dir))) {
        const path = relative(ROOT, file).replaceAll("\\", "/")
        if (PRODUCT_INSIDE.test(`/${path}`) || NOT_RUNTIME.test(`/${path}`)) continue
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .forEach((line, index) => {
            // Los comentarios pueden contar la regla con un ejemplo.
            const code = line.trim()
            if (code.startsWith("*") || code.startsWith("/*") || code.startsWith("//")) return
            if (COMPARES.test(code)) found.push(`${path}:${index + 1}: ${code}`)
          })
      }
    }
    expect(found, "Usa un Record<ClinicalProduct, …> (o por marca) o BASE_PRODUCT / BASE_MAIL_BRAND").toEqual([])
  })
})
