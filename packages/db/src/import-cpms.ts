/**
 * Importación reproducible del ámbito odontológico del CPMS oficial
 * (RM-550-2023-MINSA, Anexo N.° 1) a los seeds versionados de `seeds/`.
 *
 * Uso: `pnpm --filter @odentia/db import:cpms [ruta-local-xlsx]`
 * Sin argumento descarga la fuente oficial y verifica su SHA-256 (fail closed).
 *
 * Ámbito (extraído de la JERARQUÍA oficial, no de regex D/E):
 * - INCLUIDO: sección 1.3 Odontología completa (498 filas, con A0141, A0142,
 *   A7903 y C3201 aunque no sean D/E: son estructuralmente odontológicas) y
 *   sección 2.7 Salud Bucal completa (7 filas, con A1331). Total: 505 códigos.
 * - EXCLUIDO: 15849 «Retiro de puntos sin anestesia» (existe en el XLSX pero
 *   en §1.2.1 Sistema Tegumentario, fuera del ámbito; era el mapping ambiguo
 *   a «retiro de suturas») y las demás ~11 497 filas no odontológicas
 *   (anestesia general, cirugía no oral, laboratorio, medicina, etc.).
 * - Los 6 códigos D de la 2.7 (D1206, D1208, D1310, D1330, D1351, D1352) NO
 *   están en la 1.3: son filas distintas del mismo sistema, se importan.
 * - 59 denominaciones del seed anterior estaban recortadas/parafraseadas;
 *   aquí se usa siempre la denominación oficial ÍNTEGRA (solo trim).
 *
 * La biblioteca no sale de aquí: es de odentIA (`seeds/biblioteca.csv`, ADR
 * 0069) y cada tratamiento dice su código CPMS en `seeds/biblioteca_codigos.csv`.
 * Si una edición nueva cambia un código, se ajusta ese archivo a mano.
 *
 * Salida determinista (orden por código, LF, UTF-8 sin BOM, newline final):
 * - seeds/procedure_code_systems.csv, seeds/procedure_codes_cpms.csv
 * - seeds/procedure_catalog_release.csv (1 fila, edición vigente)
 * - seeds/cpms_scope_provenance.csv (procedencia por código: N° oficial y jerarquía)
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import xlsx from "xlsx"

const VERSION = "RM-550-2023-MINSA"
const SYSTEM = "CPMS"
const SOURCE_URL =
  "https://cdn.www.gob.pe/uploads/document/file/4660631/Parte%201%20050623%20Anexo%20Nro.%201%20Listado%20de%20Procedimientos%20M%C3%A9dicos%20y%20Sanitarios%20ok15.xlsx?v=1686924375"
const SOURCE_SHA256 = "cc71b2200e86638f3cd21acf0e133930b8182ca719eb8297091ef58675956d7a"
const SCOPE_SECTIONS: Record<string, true> = { "1.3": true, "2.7": true }
const here = dirname(fileURLToPath(import.meta.url))
const seedsDir = join(here, "..", "seeds")

interface OfficialRow {
  n: string
  group: string
  section: string
  subsection: string
  subsectionName: string
  code: string
  display: string
}

function fail(msg: string): never {
  throw new Error(`import-cpms: ${msg}`)
}

function clean(cell: unknown): string {
  if (cell === null || cell === undefined) return ""
  return String(cell).replaceAll(" ", " ").trim()
}

async function loadSource(localPath: string | undefined): Promise<Buffer> {
  if (localPath) return readFileSync(localPath)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) fail(`descarga oficial falló: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = join(tmpdir(), "cpms-fuente-oficial.xlsx")
  writeFileSync(tmp, buf)
  return buf
}

function parseRows(buf: Buffer): OfficialRow[] {
  const wb = xlsx.read(buf, { type: "buffer" })
  const ws = wb.Sheets["Parte 1"]
  if (!ws) fail("hoja «Parte 1» no encontrada en el XLSX oficial")
  const grid = xlsx.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null })
  const header = (grid[1] ?? []).map((c) => clean(c).replaceAll("\r\n", "\n"))
  if (header[1] !== "Código grupo" || header[7] !== "Código de \nprocedimiento") {
    fail(`cabecera oficial inesperada: ${JSON.stringify(header)}`)
  }
  const out: OfficialRow[] = []
  for (const line of grid.slice(2)) {
    if (!line || line.every((c) => c === null || c === undefined || String(c).trim() === ""))
      continue
    const row: OfficialRow = {
      n: clean(line[0]),
      group: clean(line[1]),
      section: clean(line[3]),
      subsection: clean(line[5]),
      subsectionName: clean(line[6]),
      code: clean(line[7]),
      display: clean(line[8]),
    }
    if (!SCOPE_SECTIONS[row.section]) continue
    if (!row.code || !row.display) fail(`fila del ámbito sin código o denominación (N° ${row.n})`)
    if (row.code.includes(",") || row.code.includes('"') || row.code.includes(":"))
      fail(`código con carácter inseguro para CSV/key: ${row.code}`)
    if (/[\r" ]/.test(row.display)) fail(`denominación con carácter inseguro: ${row.code}`)
    out.push(row)
  }
  return out
}

function writeCsv(path: string, header: string, lines: string[]): void {
  writeFileSync(path, `${header}\n${lines.join("\n")}\n`, { encoding: "utf8" })
}

async function main(): Promise<void> {
  const buf = await loadSource(process.argv[2])
  const sha = createHash("sha256").update(buf).digest("hex")
  if (sha !== SOURCE_SHA256) fail(`SHA-256 no coincide: esperado ${SOURCE_SHA256}, obtenido ${sha}`)
  const rows = parseRows(buf)
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.code)) fail(`código duplicado en el ámbito oficial: ${r.code}`)
    seen.add(r.code)
  }
  rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

  mkdirSync(seedsDir, { recursive: true })
  writeCsv(
    join(seedsDir, "procedure_code_systems.csv"),
    "key,title,publisher,country,license,source_url",
    [
      `${SYSTEM},Catálogo de Procedimientos Médicos y Sanitarios,MINSA Perú,PE,no-declarada,${SOURCE_URL}`,
    ],
  )
  writeCsv(
    join(seedsDir, "procedure_codes_cpms.csv"),
    "system_key,code,version,display",
    rows.map((r) => `${SYSTEM},${r.code},${VERSION},${r.display}`),
  )
  writeCsv(
    join(seedsDir, "procedure_catalog_release.csv"),
    "system_key,version,scope,source_url,source_sha256,expected_count,is_current",
    [
      `${SYSTEM},${VERSION},secciones 1.3 Odontología y 2.7 Salud Bucal,${SOURCE_URL},${sha},${rows.length},true`,
    ],
  )
  writeCsv(
    join(seedsDir, "cpms_scope_provenance.csv"),
    "code,n_oficial,grupo,seccion,subseccion,nombre_subseccion,denominacion",
    rows.map(
      (r) =>
        `${r.code},${r.n},${r.group},${r.section},${r.subsection},${r.subsectionName},${r.display}`,
    ),
  )
  console.log(
    `import-cpms: ${rows.length} códigos (${VERSION}, sha ${sha.slice(0, 12)}…); ` +
      `fuente verificada, seeds regenerados en seeds/`,
  )
}

await main()
