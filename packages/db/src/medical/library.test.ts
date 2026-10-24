import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TextDecoder } from "node:util"
import { MEDICAL_SERVICE_KIND_KEYS } from "@odentia/medical"
import { expect, it } from "vitest"
import { splitHead } from "../procedure-codes.js"

/**
 * La biblioteca de latidIA (issue 229, entrega 8), sin base de datos: sus CSV
 * son UTF-8 con LF, cada código existe en la edición vigente de su lista y su
 * buscador ofrece lo médico de cada lista que vale para un consultorio.
 */
const SEEDS = join(import.meta.dirname, "..", "..", "seeds")
const utf8 = new TextDecoder("utf-8", { fatal: true })

function rows(file: string, header: string, fields: number): string[][] {
  const lines = utf8.decode(readFileSync(join(SEEDS, file))).split("\n")
  expect(lines.pop(), `${file} sin newline final`).toBe("")
  expect(
    lines.some((line) => line.includes("\r")),
    `${file} con CR`,
  ).toBe(false)
  expect(lines.shift(), `${file} cabecera`).toBe(header)
  return lines.map((line) => splitHead(line, fields))
}

const RELEASES = rows(
  "procedure_catalog_release.csv",
  "system_key,version,scope,source_url,source_sha256,expected_count,is_current",
  7,
)
const versionOf = new Map(RELEASES.map(([system, version]) => [system!, version!]))
const codesOf = (system: string) =>
  new Set(
    rows(
      `procedure_codes_${system.toLowerCase()}.csv`,
      "system_key,code,version,section,display",
      5,
    ).map((row) => row[1]!),
  )
const LIBRARY = rows("biblioteca_medica.csv", "key,kind,common,name", 4)
const CODES = rows("biblioteca_medica_codigos.csv", "template_key,system_key,code,version", 4)

it("la biblioteca de latidIA: claves y nombres únicos, sus tipos y ninguna clave de la de odentIA", () => {
  const keys = LIBRARY.map((row) => row[0]!)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(LIBRARY.map((row) => row[3]!.toLowerCase())).size).toBe(LIBRARY.length)
  for (const [key, kind, common] of LIBRARY) {
    expect(key).toMatch(/^[a-z0-9-]+$/)
    expect(MEDICAL_SERVICE_KIND_KEYS as readonly string[], `tipo de ${key}`).toContain(kind)
    expect(["true", "false"]).toContain(common)
  }
  // La clave es única en la tabla: ninguna se comparte con la biblioteca de odentIA.
  const dental = new Set(
    rows(
      "biblioteca.csv",
      "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,coded_only,name",
      10,
    ).map((row) => row[0]!),
  )
  expect(keys.filter((key) => dental.has(key))).toEqual([])
  // Cada tipo tiene algo en «Más usados».
  for (const kind of [
    "general",
    "familiar",
    "interna",
    "pediatria",
    "ginecologia",
    "procedimiento",
    "diagnostico",
  ]) {
    expect(
      LIBRARY.some((row) => row[1] === kind && row[2] === "true"),
      `más usados de ${kind}`,
    ).toBe(true)
  }
})

it("cada código de la biblioteca de latidIA existe en la edición vigente de su lista, uno por lista", () => {
  const keys = new Set(LIBRARY.map((row) => row[0]!))
  const lists = new Map<string, Set<string>>()
  const seen = new Set<string>()
  for (const [key, system, code, version] of CODES) {
    expect(keys.has(key!), `servicio inexistente: ${key}`).toBe(true)
    expect(versionOf.get(system!), `edición de ${system}`).toBe(version)
    if (!lists.has(system!)) lists.set(system!, codesOf(system!))
    expect(lists.get(system!)!.has(code!), `código inexistente: ${system} ${code}`).toBe(true)
    expect(seen.has(`${key}:${system}`), `dos códigos de ${system} para ${key}`).toBe(false)
    seen.add(`${key}:${system}`)
  }
  // En Perú la lista es obligatoria: todo servicio tiene su código CPMS salvo
  // la toma del Papanicolaou, que la CPMS no tiene (solo su lectura).
  const cpms = new Set(CODES.filter((row) => row[1] === "CPMS").map((row) => row[0]!))
  expect([...keys].filter((key) => !cpms.has(key))).toEqual(["papanicolaou"])
  // Las cuatro listas con lo médico están en la biblioteca; las solo odontológicas no.
  expect([...new Set(CODES.map((row) => row[1]!))].sort()).toEqual([
    "CIE9MC-MX",
    "CPMS",
    "CUPS",
    "FONASA",
  ])
})

it("el buscador de latidIA ofrece todo lo que no es odontológico de cada lista médica, y la biblioteca está ahí", () => {
  const products = rows("procedure_code_products.csv", "system_key,product,code", 3)
  for (const system of ["CPMS", "CUPS", "CIE9MC-MX", "FONASA"]) {
    const dental = new Set(
      products.filter((row) => row[0] === system && row[1] === "dental").map((row) => row[2]!),
    )
    const medical = new Set(
      products.filter((row) => row[0] === system && row[1] === "medical").map((row) => row[2]!),
    )
    const all = codesOf(system)
    expect(medical.size + dental.size, system).toBe(all.size)
    for (const code of medical)
      expect(dental.has(code), `${system} ${code} en los dos productos`).toBe(false)
    for (const [key, list, code] of CODES.filter((row) => row[1] === system)) {
      expect(medical.has(code!), `${key}: ${list} ${code} fuera de lo médico`).toBe(true)
    }
  }
  // Las listas que solo cargaron lo odontológico no tienen nada médico.
  expect(
    products.some(
      (row) => (row[0] === "COLEGIO-CR" || row[0] === "CIE9MC-SV") && row[1] === "medical",
    ),
  ).toBe(false)
})
