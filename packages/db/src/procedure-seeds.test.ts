import { TREATMENT_SCOPES, TREATMENT_SPECIALTIES } from "@odentia/clinical"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

// Los seeds se leen como UTF-8 estricto en runtime: un byte latin-1 suelto
// se convierte en U+FFFD silencioso (mojibake en pantalla). Estos tests lo
// atrapan antes del merge, sin base de datos, y concilian la cobertura 1:1
// con la edición oficial (release.expected_count).
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
  "treatment_templates_cpms.csv",
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
      "treatment_templates_cpms.csv",
      "template_key,specialty,scope,surface_count_min,surface_count_max,system_key,code,version,name",
    ).length,
  ).toBe(expected)
  expect(
    linesOf(
      "cpms_scope_provenance.csv",
      "code,n_oficial,grupo,seccion,subseccion,nombre_subseccion,denominacion",
    ).length,
  ).toBe(expected)
})

it("cada código oficial del ámbito tiene plantilla 1:1 sin duplicados ni faltantes", () => {
  const codeLines = linesOf("procedure_codes_cpms.csv", "system_key,code,version,display")
  const codes = codeLines.map((l) => {
    const [system, code, version, display] = head(l, 4)
    expect(system).toBe("CPMS")
    expect(version).toBe("RM-550-2023-MINSA")
    expect(code).not.toBe("")
    expect(display).not.toBe("")
    return code!
  })
  expect(new Set(codes).size).toBe(codes.length)

  const tplLines = linesOf(
    "treatment_templates_cpms.csv",
    "template_key,specialty,scope,surface_count_min,surface_count_max,system_key,code,version,name",
  )
  const tplCodes = tplLines.map((l) => {
    const [key, specialty, scope, minRaw, maxRaw, system, code, version, name] = head(l, 9)
    expect(key).toBe(`cpms:${version}:${code}`)
    expect(TREATMENT_SCOPES).toContain(scope)
    expect(TREATMENT_SPECIALTIES).toContain(specialty)
    expect(name).not.toBe("")
    if (scope === "surfaces") {
      expect(minRaw).not.toBe("")
      expect(maxRaw).not.toBe("")
    } else {
      expect(minRaw).toBe("")
      expect(maxRaw).toBe("")
    }
    expect(system).toBe("CPMS")
    return code!
  })
  expect(new Set(tplLines).size).toBe(tplLines.length)
  // Mapping único en ambos sentidos: mismos códigos, sin faltantes ni extras.
  expect([...tplCodes].sort()).toEqual([...codes].sort())
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

it("denominaciones íntegras y D2391 con scope surfaces 1", () => {
  const byCode = new Map(
    linesOf("procedure_codes_cpms.csv", "system_key,code,version,display").map((l) => {
      const [, code, , display] = head(l, 4)
      return [code, display] as const
    }),
  )
  expect(byCode.get("D0170")).toContain("centrada en el problema")
  expect(byCode.get("D2335")).toContain("ángulo incisal")
  const tplByCode = new Map(
    linesOf(
      "treatment_templates_cpms.csv",
      "template_key,specialty,scope,surface_count_min,surface_count_max,system_key,code,version,name",
    ).map((l) => {
      const [key, , scope, minRaw, maxRaw, , code, , name] = head(l, 9)
      return [code, { key, scope, minRaw, maxRaw, name }] as const
    }),
  )
  const d2391 = tplByCode.get("D2391")!
  expect(d2391.key).toBe("cpms:RM-550-2023-MINSA:D2391")
  expect(d2391.scope).toBe("surfaces")
  expect(d2391.minRaw).toBe("1")
  expect(d2391.maxRaw).toBe("1")
  expect(d2391.name).toBe(byCode.get("D2391"))
})
