import { TREATMENT_KIND_KEYS, TREATMENT_SCOPES, validateLeavesFinding } from "@odentia/clinical"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

// Los seeds se leen como UTF-8 estricto en runtime: un byte latin-1 suelto
// se convierte en U+FFFD silencioso (mojibake en pantalla). Estos tests lo
// atrapan antes del merge, sin base de datos, y concilian la cobertura de la
// lista oficial (release.expected_count) y la biblioteca de odentIA (ADR 0067).
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

const FILES = [
  "procedure_code_systems.csv",
  "procedure_codes_cpms.csv",
  "biblioteca.csv",
  "biblioteca_codigos.csv",
  "procedure_catalog_release.csv",
  "cpms_scope_provenance.csv",
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

it("release de una fila con sha válido y expected_count que concilia todo", () => {
  const lines = linesOf(
    "procedure_catalog_release.csv",
    "system_key,version,scope,source_url,source_sha256,expected_count,is_current",
  )
  expect(lines.length).toBe(1)
  const [system, version, scope, url, sha, expectedRaw, current] = head(lines[0]!, 7)
  expect(system).toBe("CPMS")
  expect(version).toBe("RM-550-2023-MINSA")
  expect(scope).toBe("secciones 1.3 Odontología y 2.7 Salud Bucal")
  expect(url).toContain("gob.pe")
  expect(sha).toMatch(/^[0-9a-f]{64}$/)
  const expected = Number(expectedRaw)
  expect(Number.isInteger(expected) && expected > 0).toBe(true)
  expect(current).toBe("true")
  expect(linesOf("procedure_codes_cpms.csv", "system_key,code,version,display").length).toBe(
    expected,
  )
  expect(
    linesOf(
      "cpms_scope_provenance.csv",
      "code,n_oficial,grupo,seccion,subseccion,nombre_subseccion,denominacion",
    ).length,
  ).toBe(expected)
})

const LIBRARY_HEADER =
  "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,name"

it("la biblioteca es de consultorio: claves y nombres únicos, ámbito y lo que deja coherentes", () => {
  const rows = linesOf("biblioteca.csv", LIBRARY_HEADER).map((l) => head(l, 9))
  const keys = rows.map(([key]) => key!)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(rows.map((row) => row[8]!.toLowerCase())).size).toBe(rows.length)
  for (const [key, kind, scope, minRaw, maxRaw, condition, variant, common, name] of rows) {
    expect(key).toMatch(/^[a-z0-9-]+$/)
    expect(TREATMENT_KIND_KEYS).toContain(kind)
    expect(TREATMENT_SCOPES).toContain(scope)
    expect(["true", "false"]).toContain(common)
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
  const names = rows.map((row) => row[8]!)
  expect(names).not.toContain("Examen dental post morten")
  expect(names.some((name) => name.includes("Cultivo viral"))).toBe(false)
  // «Más usados» es un punto de partida, no la lista entera.
  const common = rows.filter((row) => row[7] === "true").length
  expect(common).toBeGreaterThanOrEqual(20)
  expect(common).toBeLessThanOrEqual(40)
})

it("cada tratamiento de la biblioteca tiene su código CPMS, que existe en la edición vigente", () => {
  const codes = new Set(
    linesOf("procedure_codes_cpms.csv", "system_key,code,version,display").map((l) => {
      const [system, code, version, display] = head(l, 4)
      expect(system).toBe("CPMS")
      expect(version).toBe("RM-550-2023-MINSA")
      expect(display).not.toBe("")
      return code!
    }),
  )
  const keys = linesOf("biblioteca.csv", LIBRARY_HEADER).map((l) => head(l, 9)[0]!)
  const mapped = linesOf("biblioteca_codigos.csv", "template_key,system_key,code,version").map((l) => {
    const [key, system, code, version] = head(l, 4)
    expect(system).toBe("CPMS")
    expect(version).toBe("RM-550-2023-MINSA")
    expect(codes.has(code!), `código inexistente: ${code}`).toBe(true)
    return key!
  })
  // En Perú la lista es obligatoria: todo tratamiento lleva uno, y solo uno.
  expect([...mapped].sort()).toEqual([...keys].sort())
})

it("procedencia cubre cada código con su denominación oficial", () => {
  const displays = new Map(
    linesOf("procedure_codes_cpms.csv", "system_key,code,version,display").map((l) => {
      const [, code, , display] = head(l, 4)
      return [code, display] as const
    }),
  )
  for (const l of linesOf(
    "cpms_scope_provenance.csv",
    "code,n_oficial,grupo,seccion,subseccion,nombre_subseccion,denominacion",
  )) {
    const [code, n, group, section, subsection, subsectionName, display] = head(l, 7)
    expect(["1.3", "2.7"]).toContain(section)
    expect(n).not.toBe("")
    expect(group).not.toBe("")
    expect(subsection).not.toBe("")
    expect(subsectionName).not.toBe("")
    expect(displays.get(code), `procedencia sin código: ${code}`).toBe(display)
  }
})

it("ámbito conciliado: incluye A/C oficiales y excluye el fuera de ámbito", () => {
  const codes = new Set(
    linesOf("procedure_codes_cpms.csv", "system_key,code,version,display").map(
      (l) => head(l, 4)[1],
    ),
  )
  for (const required of ["A0141", "A0142", "A7903", "C3201", "A1331"]) {
    expect(codes.has(required), `código oficial del ámbito faltante: ${required}`).toBe(true)
  }
  expect(codes.has("15849"), "15849 es §1.2.1, fuera del ámbito odontológico").toBe(false)
})

it("la lista oficial conserva sus denominaciones y la biblioteca tiene nombres propios", () => {
  const byCode = new Map(
    linesOf("procedure_codes_cpms.csv", "system_key,code,version,display").map((l) => {
      const [, code, , display] = head(l, 4)
      return [code, display] as const
    }),
  )
  expect(byCode.get("D0170")).toContain("centrada en el problema")
  expect(byCode.get("D2335")).toContain("ángulo incisal")
  // En la biblioteca, D2391 es la resina posterior de una superficie, con nombre propio.
  const keyOf = new Map(
    linesOf("biblioteca_codigos.csv", "template_key,system_key,code,version").map((l) => {
      const [key, , code] = head(l, 4)
      return [code, key] as const
    }),
  )
  const library = new Map(
    linesOf("biblioteca.csv", LIBRARY_HEADER).map((l) => {
      const [key, , scope, minRaw, maxRaw, condition, variant, , name] = head(l, 9)
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
