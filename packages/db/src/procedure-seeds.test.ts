import { TREATMENT_KIND_KEYS, TREATMENT_SCOPES, validateLeavesFinding } from "@odentia/dental"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { loadPatientGuides } from "./procedure-codes.js"

// Los seeds se leen como UTF-8 estricto en runtime: un byte latin-1 suelto
// se convierte en U+FFFD silencioso (mojibake en pantalla). Estos tests lo
// atrapan antes del merge, sin base de datos, y concilian la cobertura de la
// lista oficial (release.expected_count) y la biblioteca de odentIA (ADR 0069).
const here = dirname(fileURLToPath(import.meta.url))
const utf8 = new TextDecoder("utf-8", { fatal: true })

function strictRead(file: string): string {
  const raw = readFileSync(join(here, "..", "seeds", file))
  return utf8.decode(raw)
}

function linesOf(file: string, header: string): string[] {
  const lines = strictRead(file).split("\n")
  expect(lines[lines.length - 1], `${file} sin newline final`).toBe("")
  lines.pop()
  expect(
    lines.some((l) => l.includes("\r")),
    `${file} con CR`,
  ).toBe(false)
  const actual = lines.shift()
  expect(actual, `${file} cabecera`).toBe(header)
  return lines
}

const RELEASE_HEADER = "system_key,version,scope,source_url,source_sha256,expected_count,is_current"
const CODES_HEADER = "system_key,code,version,section,display"

/** Los códigos de una lista: [lista, código, edición, sección, denominación]. */
function codesOf(file: string): string[][] {
  return linesOf(file, CODES_HEADER).map((l) => head(l, 5))
}

/** Las ediciones vigentes, una por lista, leídas sin pasar por expect (para nombrar las pruebas). */
const RELEASES = strictRead("procedure_catalog_release.csv")
  .split("\n")
  .slice(1)
  .filter(Boolean)
  .map((line) => {
    const [systemKey, version] = line.split(",")
    return { systemKey: systemKey!, version: version!, file: `procedure_codes_${systemKey!.toLowerCase()}.csv` }
  })

const FILES = [
  "procedure_code_systems.csv",
  "biblioteca.csv",
  "biblioteca_codigos.csv",
  "procedure_catalog_release.csv",
  "procedure_code_products.csv",
  ...RELEASES.map((release) => release.file),
]

for (const file of FILES) {
  it(`${file} es UTF-8 válido, sin reemplazos y con LF`, () => {
    const text = strictRead(file)
    expect(text).not.toContain("�")
    expect(text).not.toContain("\r")
    expect(text.endsWith("\n")).toBe(true)
  })
}

function head(line: string, n: number): string[] {
  const parts: string[] = []
  let rest = line
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(",")
    expect(idx, `línea inválida: ${line}`).toBeGreaterThan(-1)
    parts.push(rest.slice(0, idx).trim())
    rest = rest.slice(idx + 1)
  }
  parts.push(rest.trim())
  return parts
}

it("una edición vigente por lista, con sha válido y expected_count que concilia sus códigos", () => {
  const systems = new Set(
    linesOf("procedure_code_systems.csv", "key,title,publisher,country,license,source_url").map((l) => head(l, 6)[0]),
  )
  const rows = linesOf("procedure_catalog_release.csv", RELEASE_HEADER).map((l) => head(l, 7))
  expect(new Set(rows.map((row) => row[0])).size).toBe(rows.length)
  for (const [system, version, scope, url, sha, expectedRaw, current] of rows) {
    expect(systems.has(system), `lista sin sistema: ${system}`).toBe(true)
    expect(version).not.toBe("")
    expect(scope).not.toBe("")
    expect(url).toMatch(/^https:\/\//)
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    const expected = Number(expectedRaw)
    expect(Number.isInteger(expected) && expected > 0).toBe(true)
    expect(current).toBe("true")
    const codes = codesOf(`procedure_codes_${system!.toLowerCase()}.csv`)
    expect(codes.length, system).toBe(expected)
    expect(new Set(codes.map((c) => c[1])).size, `${system} sin duplicados`).toBe(codes.length)
    for (const [codeSystem, code, codeVersion, section, display] of codes) {
      expect(codeSystem).toBe(system)
      expect(codeVersion).toBe(version)
      expect(code).not.toBe("")
      expect(section).not.toBe("")
      expect(display).not.toBe("")
    }
  }
  // La CPMS del Perú, completa (entrega 7 del ADR 0079).
  const cpms = rows.find((row) => row[0] === "CPMS")!
  expect(cpms.slice(0, 3)).toEqual(["CPMS", "RM-550-2023-MINSA", "completa: Anexo N.° 1 (Parte 1)"])
  expect(cpms[3]).toContain("gob.pe")
  expect(Number(cpms[5])).toBe(12002)
})

it("los códigos de cada producto existen en su lista y odentIA usa los odontológicos", () => {
  const codes = new Map(RELEASES.map((release) => [release.systemKey, new Map(codesOf(release.file).map((c) => [c[1]!, c]))]))
  const rows = linesOf("procedure_code_products.csv", "system_key,product,code").map((l) => head(l, 3))
  expect(new Set(rows.map((row) => row.join(":"))).size).toBe(rows.length)
  for (const [system, product, code] of rows) {
    expect(product).toMatch(/^[a-z]+$/)
    expect(codes.get(system!)?.has(code!), `código de un producto que no está: ${system} ${code}`).toBe(true)
  }
  // Cada lista tiene su parte dental.
  const dental = (system: string) => rows.filter(([s, product]) => s === system && product === "dental").map((row) => row[2]!)
  for (const release of RELEASES) expect(dental(release.systemKey).length, release.systemKey).toBeGreaterThan(0)
  // En la CPMS, lo dental son exactamente las secciones 1.3 Odontología y 2.7 Salud Bucal.
  const bySection = [...codes.get("CPMS")!.values()].filter((c) => c[3] === "1.3" || c[3] === "2.7").map((c) => c[1]!)
  expect(dental("CPMS").sort()).toEqual(bySection.sort())
  expect(bySection).toHaveLength(505)
})

it("cada código de la biblioteca existe en su lista, en su edición vigente, y uno por lista", () => {
  const versions = new Map(RELEASES.map((release) => [release.systemKey, release.version]))
  const codes = new Map(
    RELEASES.map((release) => [release.systemKey, new Set(codesOf(release.file).map((c) => c[1]))]),
  )
  const keys = new Set(linesOf("biblioteca.csv", LIBRARY_HEADER).map((l) => head(l, 10)[0]))
  const seen = new Set<string>()
  for (const l of linesOf("biblioteca_codigos.csv", "template_key,system_key,code,version")) {
    const [key, system, code, version] = head(l, 4)
    expect(keys.has(key), `tratamiento inexistente: ${key}`).toBe(true)
    expect(versions.get(system!), `lista sin edición: ${system}`).toBe(version)
    expect(codes.get(system!)!.has(code), `código inexistente: ${system} ${code}`).toBe(true)
    expect(seen.has(`${key}:${system}`), `dos códigos de ${system} para ${key}`).toBe(false)
    seen.add(`${key}:${system}`)
  }
})

const LIBRARY_HEADER =
  "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,coded_only,name"

it("la biblioteca es de consultorio: claves y nombres únicos, ámbito y lo que deja coherentes", () => {
  const rows = linesOf("biblioteca.csv", LIBRARY_HEADER).map((l) => head(l, 10))
  const keys = rows.map(([key]) => key!)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(rows.map((row) => row[9]!.toLowerCase())).size).toBe(rows.length)
  for (const [key, kind, scope, minRaw, maxRaw, condition, variant, common, codedOnly, name] of rows) {
    expect(key).toMatch(/^[a-z0-9-]+$/)
    expect(TREATMENT_KIND_KEYS).toContain(kind)
    expect(TREATMENT_SCOPES).toContain(scope)
    expect(["true", "false"]).toContain(common)
    expect(["true", "false"]).toContain(codedOnly)
    expect(name).not.toBe("")
    if (scope === "surfaces") {
      expect(Number(minRaw)).toBeGreaterThanOrEqual(1)
      expect(Number(maxRaw)).toBeGreaterThanOrEqual(Number(minRaw))
    } else {
      expect(minRaw).toBe("")
      expect(maxRaw).toBe("")
    }
    if (condition) {
      const leaves = variant ? { condition, variant } : { condition }
      expect(validateLeavesFinding(leaves, { scope, strictVariants: false }), key).toEqual([])
    } else {
      expect(variant).toBe("")
    }
  }
  // Lo que no hace un consultorio quedó fuera.
  const names = rows.map((row) => row[9]!)
  expect(names).not.toContain("Examen dental post morten")
  expect(names.some((name) => name.includes("Cultivo viral"))).toBe(false)
  // «Más usados» es un punto de partida, no la lista entera.
  // Las variantes de la norma de un país no cuentan: solo se ven donde tienen código.
  const common = rows.filter((row) => row[7] === "true" && row[8] === "false").length
  expect(common).toBeGreaterThanOrEqual(20)
  expect(common).toBeLessThanOrEqual(40)
})

it("cada tratamiento de la biblioteca tiene su código CPMS, que existe en la edición vigente", () => {
  const codes = new Set(
    codesOf("procedure_codes_cpms.csv").map(([system, code, version, , display]) => {
      expect(system).toBe("CPMS")
      expect(version).toBe("RM-550-2023-MINSA")
      expect(display).not.toBe("")
      return code!
    }),
  )
  // Las variantes de la norma de otro país (coded_only) no se ofrecen en el Perú.
  const keys = linesOf("biblioteca.csv", LIBRARY_HEADER)
    .map((l) => head(l, 10))
    .filter((row) => row[8] === "false")
    .map((row) => row[0]!)
  const mapped = linesOf("biblioteca_codigos.csv", "template_key,system_key,code,version")
    .map((l) => head(l, 4))
    .filter(([, system]) => system === "CPMS")
    .map(([key, , code, version]) => {
      expect(version).toBe("RM-550-2023-MINSA")
      expect(codes.has(code!), `código inexistente: ${code}`).toBe(true)
      return key!
    })
  // En Perú la lista es obligatoria: todo tratamiento lleva uno, y solo uno.
  expect([...mapped].sort()).toEqual([...keys].sort())
})

it("lo dental de la CPMS: incluye los A/C de sus secciones y deja fuera lo de otras", () => {
  const dental = new Set(
    linesOf("procedure_code_products.csv", "system_key,product,code")
      .map((l) => head(l, 3))
      .filter(([system, product]) => system === "CPMS" && product === "dental")
      .map((row) => row[2]),
  )
  for (const required of ["A0141", "A0142", "A7903", "C3201", "A1331"]) {
    expect(dental.has(required), `código odontológico faltante: ${required}`).toBe(true)
  }
  // 15849 «Retiro de puntos sin anestesia» está en la lista completa (§1.2.1), pero no es de odentIA.
  expect(codesOf("procedure_codes_cpms.csv").find((c) => c[1] === "15849")?.[3]).toBe("1.2")
  expect(dental.has("15849")).toBe(false)
})

it("la lista oficial conserva sus denominaciones y la biblioteca tiene nombres propios", () => {
  const byCode = new Map(
    codesOf("procedure_codes_cpms.csv").map(([, code, , , display]) => [code, display] as const),
  )
  expect(byCode.get("D0170")).toContain("centrada en el problema")
  expect(byCode.get("D2335")).toContain("ángulo incisal")
  // En la biblioteca, D2391 es la resina posterior de una superficie, con nombre propio.
  const keyOf = new Map(
    linesOf("biblioteca_codigos.csv", "template_key,system_key,code,version")
      .map((l) => head(l, 4))
      .filter(([, system]) => system === "CPMS")
      .map(([key, , code]) => [code, key] as const),
  )
  const library = new Map(
    linesOf("biblioteca.csv", LIBRARY_HEADER).map((l) => {
      const [key, , scope, minRaw, maxRaw, condition, variant, , , name] = head(l, 10)
      return [key, { scope, minRaw, maxRaw, condition, variant, name }] as const
    }),
  )
  const d2391 = library.get(keyOf.get("D2391")!)!
  expect(d2391).toMatchObject({ scope: "surfaces", minRaw: "1", maxRaw: "1", condition: "definitive_restoration", variant: "resin" })
  expect(d2391.name).toBe("Resina fotocurable, 1 superficie, posterior")
  expect(d2391.name).not.toBe(byCode.get("D2391"))
  // El sellante se dibuja en las caras: va por superficies (revisión del tablero 7b).
  expect(library.get(keyOf.get("D1351")!)).toMatchObject({ scope: "surfaces", condition: "sealant" })
})

it("las explicaciones sugeridas: una clave que no es de la biblioteca falla antes de tocar la base", () => {
  expect(loadPatientGuides(["endo"], '{"endo":{"how":"  Paso a paso  "}}').get("endo")).toEqual({ how: "Paso a paso" })
  expect(() => loadPatientGuides(["endo"], '{"no_existe":{"how":"Algo"}}')).toThrow(/no_existe/)
  expect(() => loadPatientGuides(["endo"], '{"endo":{"how":"   "}}')).toThrow(/vacía/)
  // El archivo vigente en el repositorio se lee sin error.
  expect(() => loadPatientGuides([])).not.toThrow()
})
