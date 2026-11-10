/**
 * Lo común nunca compara productos ni marcas a mano (`product === "medical" ?
 * … : …`): un producto nuevo caería en silencio en la rama de otro (sus
 * palabras, su marca, su dominio, sus mensajes). Decide con un mapa completo por
 * producto (`Record<ClinicalProduct, …>`) o por marca, así el compilador señala
 * cada lugar que tiene que decir algo del nuevo. Lo que es del producto base
 * (odentIA: el dominio de la plataforma, el remitente de siempre) se compara con
 * `BASE_PRODUCT` o `BASE_MAIL_BRAND`, nunca con su nombre escrito (ADR 0168).
 *
 * Revisa todo paquete y app con `src`, salvo los de cada producto (que sí se
 * nombran a sí mismos) y la web de marketing, que se arma aparte para cada
 * producto y detiene el armado ante uno que no conoce (`apps/web/astro.config.mjs`).
 * Quedan fuera las pruebas, las stories y las mediciones, que eligen la clínica de
 * la semilla de cada producto.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { productWords } from "./product-words.js"
import { CLINICAL_PRODUCTS } from "./products.js"

const ROOT = join(import.meta.dirname, "..", "..", "..")

/** Cómo se nombra cada producto en el código: su clave, su marca y su nombre. */
const NAMES = [
  ...new Set(CLINICAL_PRODUCTS.flatMap((product) => [product, productWords(product).brand, productWords(product).name])),
].join("|")

const Q = "[\"'`]"
/** Una comparación con el nombre escrito: en JavaScript, en un `case`, en drizzle o en SQL a mano. */
const COMPARES = new RegExp(
  [
    `(===?|!==?)\\s*${Q}(${NAMES})${Q}`,
    `${Q}(${NAMES})${Q}\\s*(===?|!==?)`,
    `\\bcase\\s+${Q}(${NAMES})${Q}\\s*:`,
    `\\b(eq|ne)\\([^()]*,\\s*${Q}(${NAMES})${Q}\\s*\\)`,
    `(=|<>|!=)\\s*'(${NAMES})'`,
  ].join("|"),
  "i",
)

/** Los paquetes y apps de un producto: `packages/<producto>`, `apps/<producto>-clinic` (ADR 0079), y la web. */
const PRODUCT_OWN = new Set([
  ...CLINICAL_PRODUCTS.flatMap((product) => [`packages/${product}`, `apps/${product}-clinic`]),
  "apps/web",
])

/** Las carpetas de un producto dentro de lo común (`services/src/dental/`). */
const PRODUCT_INSIDE = new RegExp(`/(${CLINICAL_PRODUCTS.join("|")})/`)

/** Pruebas, stories y lo generado: no corren para una clínica. */
const NOT_RUNTIME = /\.(test|spec|stories)\.tsx?$|\.eval\.ts$|\/routeTree\.gen\.ts$/

/** Las mediciones, por su nombre: eligen la clínica de la semilla de cada producto. */
const MEASUREMENTS =
  /^packages\/agent\/src\/(.*\/)?(auditoria-[^/]+|eval(-[^/]+)?|help-measure)\.ts$|^packages\/services\/src\/help-guide-suite\.ts$/

function commonDirs(): string[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
      .filter((dir) => !PRODUCT_OWN.has(dir) && existsSync(join(ROOT, dir, "src")))
      .map((dir) => `${dir}/src`),
  )
}

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
  it("reconoce las comparaciones con el nombre escrito, y no los mapas ni las palabras", () => {
    const caught = [
      'if (product === "medical") {',
      "const x = brand !== 'latidia' ? a : b",
      "if (product == `dental`) return",
      'words.name === "latidIA"',
      '"dental" !== product',
      'case "odentia":',
      '.where(eq(orgProfile.product, "medical"))',
      "sql`select 1 where product = 'medical'`",
    ]
    const ignored = [
      'const WORDS = { dental: "odontograma", medical: "examen físico" }',
      'productWords("medical")',
      'product: text("product").notNull().default("dental"),',
      "check(\"x\", sql`${table.product} IN ('dental','medical')`)",
      "return product === BASE_PRODUCT ? undefined : domains[product]",
    ]
    expect(caught.filter((line) => !COMPARES.test(line))).toEqual([])
    expect(ignored.filter((line) => COMPARES.test(line))).toEqual([])
  })

  it("ningún código común compara un producto o una marca con su nombre escrito", () => {
    const dirs = commonDirs()
    // Lo común de hoy está en la lista: si no, la búsqueda de carpetas se rompió.
    expect(dirs).toEqual(expect.arrayContaining(["packages/services/src", "packages/clinic-app/src", "apps/api/src"]))
    const found: string[] = []
    for (const dir of dirs) {
      for (const file of filesUnder(join(ROOT, dir))) {
        const path = relative(ROOT, file).replaceAll("\\", "/")
        if (PRODUCT_INSIDE.test(`/${path}`) || NOT_RUNTIME.test(path) || MEASUREMENTS.test(path)) continue
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
