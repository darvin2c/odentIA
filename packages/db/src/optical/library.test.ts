import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TextDecoder } from "node:util"
import { OPTICAL_SERVICE_KIND_KEYS } from "@odentia/optical"
import { expect, it } from "vitest"
import { splitHead } from "../procedure-codes.js"

/**
 * La biblioteca de vistIA, sin base de datos: sus CSV son UTF-8 con LF, cada
 * código existe en la edición vigente de su lista y el buscador de la óptica
 * ofrece lo del ojo de cada lista, con todo lo de su biblioteca.
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
    rows(`procedure_codes_${system.toLowerCase()}.csv`, "system_key,code,version,section,display", 5).map(
      (row) => row[1]!,
    ),
  )
const LIBRARY = rows("biblioteca_optica.csv", "key,kind,common,name", 4)
const CODES = rows("biblioteca_optica_codigos.csv", "template_key,system_key,code,version", 4)

it("la biblioteca de vistIA: claves y nombres únicos, sus tipos y ninguna clave de otra biblioteca", () => {
  const keys = LIBRARY.map((row) => row[0]!)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(LIBRARY.map((row) => row[3]!.toLowerCase())).size).toBe(LIBRARY.length)
  for (const [key, kind, common] of LIBRARY) {
    expect(key).toMatch(/^[a-z0-9-]+$/)
    expect(OPTICAL_SERVICE_KIND_KEYS as readonly string[], `tipo de ${key}`).toContain(kind)
    expect(["true", "false"]).toContain(common)
  }
  // La clave es única en la tabla: ninguna se comparte con la de odentIA ni con la de latidIA.
  const others = new Set([
    ...rows(
      "biblioteca.csv",
      "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,coded_only,name",
      10,
    ).map((row) => row[0]!),
    ...rows("biblioteca_medica.csv", "key,kind,common,name", 4).map((row) => row[0]!),
  ])
  expect(keys.filter((key) => others.has(key))).toEqual([])
  // Cada tipo tiene algo en «Más usados», salvo las pruebas especiales, que dependen del equipo de cada óptica.
  for (const kind of OPTICAL_SERVICE_KIND_KEYS.filter((kind) => kind !== "pruebas")) {
    expect(
      LIBRARY.some((row) => row[1] === kind && row[2] === "true"),
      `más usados de ${kind}`,
    ).toBe(true)
  }
})

it("cada código de la biblioteca de vistIA existe en la edición vigente de su lista, uno por lista", () => {
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
  // En Perú todo servicio tiene su código CPMS salvo los que la CPMS no tiene:
  // la evaluación de baja visión y la tonometría simple (solo la seriada).
  const cpms = new Set(CODES.filter((row) => row[1] === "CPMS").map((row) => row[0]!))
  expect([...keys].filter((key) => !cpms.has(key))).toEqual(["evaluacion-baja-vision", "tonometria"])
})

it("el buscador de vistIA ofrece lo del ojo de cada lista, con toda su biblioteca", () => {
  const products = rows("procedure_code_products.csv", "system_key,product,code", 3)
  for (const system of ["CPMS", "CUPS", "CIE9MC-MX", "FONASA"]) {
    const optical = new Set(
      products.filter((row) => row[0] === system && row[1] === "optical").map((row) => row[2]!),
    )
    expect(optical.size, system).toBeGreaterThan(0)
    const all = codesOf(system)
    for (const code of optical) expect(all.has(code), `${system} ${code} fuera de la lista`).toBe(true)
    for (const [key, list, code] of CODES.filter((row) => row[1] === system)) {
      expect(optical.has(code!), `${key}: ${list} ${code} fuera de lo óptico`).toBe(true)
    }
  }
})
