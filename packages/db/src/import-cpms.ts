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
 * Metadatos (specialty/scope/superficies): tabla explícita por subsección +
 * overrides por código. Regla: ante la duda, scope `general` (sin inferencias
 * anatómicas frágiles); `surfaces` solo donde el texto oficial cuenta
 * superficies; `tooth`/`arch`/`quadrant` solo donde el texto o la definición
 * de la subsección lo fundamentan. D2391 → surfaces 1/1 (una superficie).
 *
 * Salida determinista (orden por código, LF, UTF-8 sin BOM, newline final):
 * - seeds/procedure_code_systems.csv, seeds/procedure_codes_cpms.csv
 * - seeds/treatment_templates_cpms.csv (proyección 1:1, key cpms:versión:código)
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

type Scope = "general" | "tooth" | "surfaces" | "quadrant" | "arch"

interface SubMeta {
  specialty: string
  scope: Scope
}

const SUBSECTION_META: Record<string, SubMeta> = {
  "1.3.1": { specialty: "diagnostico", scope: "general" },
  "1.3.2": { specialty: "odontopediatria", scope: "general" },
  "1.3.3": { specialty: "restauradora", scope: "surfaces" },
  "1.3.4": { specialty: "restauradora", scope: "surfaces" },
  "1.3.5": { specialty: "restauradora", scope: "tooth" },
  "1.3.6": { specialty: "protesis", scope: "tooth" },
  "1.3.7": { specialty: "protesis", scope: "tooth" },
  "1.3.8": { specialty: "endodoncia", scope: "tooth" },
  "1.3.9": { specialty: "periodoncia", scope: "general" },
  "1.3.10": { specialty: "protesis", scope: "arch" },
  "1.3.11": { specialty: "protesis", scope: "arch" },
  "1.3.12": { specialty: "protesis", scope: "arch" },
  "1.3.13": { specialty: "protesis", scope: "arch" },
  "1.3.14": { specialty: "protesis", scope: "arch" },
  "1.3.15": { specialty: "protesis", scope: "general" },
  "1.3.16": { specialty: "implantologia", scope: "general" },
  "1.3.17": { specialty: "protesis", scope: "tooth" },
  "1.3.18": { specialty: "cirugia", scope: "general" },
  "1.3.19": { specialty: "ortodoncia", scope: "general" },
  "1.3.20": { specialty: "general", scope: "general" },
  "1.3.21": { specialty: "restauradora", scope: "general" },
  "2.7.1": { specialty: "prevencion", scope: "general" },
  "2.7.2": { specialty: "prevencion", scope: "general" },
}

/** Overrides por código: specialty, scope y superficies donde el texto oficial lo fundamenta. */
const CODE_OVERRIDES: Record<
  string,
  { specialty?: string; scope?: Scope; min?: number; max?: number }
> = {
  // 1.3.3 amalgama: conteo del texto oficial (D2161 dice «cuatro», no «o más»: 4/4).
  D2140: { min: 1, max: 1 },
  D2150: { min: 2, max: 2 },
  D2160: { min: 3, max: 3 },
  D2161: { min: 4, max: 4 },
  // 1.3.4 resina fotocurable/autocurable anterior y posterior.
  D2330: { min: 1, max: 1 },
  D2331: { min: 2, max: 2 },
  D2332: { min: 3, max: 3 },
  D2335: { min: 4, max: 5 },
  D2385: { min: 1, max: 1 },
  D2386: { min: 2, max: 2 },
  D2390: { scope: "tooth" },
  D2391: { min: 1, max: 1 },
  D2392: { min: 2, max: 2 },
  D2393: { min: 3, max: 3 },
  D2394: { min: 4, max: 5 },
  E2336: { min: 1, max: 1 },
  E2337: { min: 2, max: 2 },
  E2338: { min: 3, max: 3 },
  E2339: { min: 4, max: 5 },
  E2340: { min: 1, max: 1 },
  E2341: { min: 2, max: 2 },
  E2342: { min: 3, max: 3 },
  E2343: { min: 4, max: 5 },
  // 1.3.7: inespecíficos y conectores de tramo → general (el resto es unitario).
  D2999: { scope: "general" },
  D6920: { scope: "general" },
  D6930: { scope: "general" },
  D6940: { scope: "general" },
  D6980: { scope: "general" },
  D6985: { scope: "general" },
  D6999: { scope: "general" },
  // 1.3.8: inespecífico → general.
  D3999: { scope: "general" },
  // 1.3.9: «por cuadrante» textual → quadrant (con alternativa «o sextantes» se queda en general).
  D4240: { scope: "quadrant" },
  D4241: { scope: "quadrant" },
  D4341: { scope: "quadrant" },
  D4342: { scope: "quadrant" },
  E4250: { scope: "quadrant" },
  // 1.3.16: cuerpo del implante y elementos unitarios → tooth; arcada edéntula → arch.
  D6010: { scope: "tooth" },
  D6040: { scope: "tooth" },
  D6050: { scope: "tooth" },
  D6053: { scope: "arch" },
  D6054: { scope: "arch" },
  D6056: { scope: "tooth" },
  D6057: { scope: "tooth" },
  D6058: { scope: "tooth" },
  D6060: { scope: "tooth" },
  D6061: { scope: "tooth" },
  D6063: { scope: "tooth" },
  D6064: { scope: "tooth" },
  D6065: { scope: "tooth" },
  D6070: { scope: "tooth" },
  D6071: { scope: "tooth" },
  D6073: { scope: "tooth" },
  D6074: { scope: "tooth" },
  D6075: { scope: "tooth" },
  D6076: { scope: "tooth" },
  D6078: { scope: "arch" },
  D6079: { scope: "arch" },
  D6094: { scope: "tooth" },
  D6095: { scope: "tooth" },
  D6100: { scope: "tooth" },
  D6194: { scope: "tooth" },
  // 1.3.18: exodoncias y actos unitarios → tooth; alveoloplastías «por cuadrante» → quadrant; arco → arch.
  D7111: { scope: "tooth" },
  D7140: { scope: "tooth" },
  D7176: { scope: "tooth" },
  D7210: { scope: "tooth" },
  D7220: { scope: "tooth" },
  D7230: { scope: "tooth" },
  D7240: { scope: "tooth" },
  D7241: { scope: "tooth" },
  D7250: { scope: "tooth" },
  D7270: { scope: "tooth" },
  D7272: { scope: "tooth" },
  D7280: { scope: "tooth" },
  D7282: { scope: "tooth" },
  D7283: { scope: "tooth" },
  D7290: { scope: "tooth" },
  D7291: { scope: "tooth" },
  D7310: { scope: "quadrant" },
  D7311: { scope: "quadrant" },
  D7320: { scope: "quadrant" },
  D7321: { scope: "quadrant" },
  D7970: { scope: "arch" },
  D7971: { scope: "tooth" },
  A7903: { scope: "tooth" },
  E7251: { scope: "tooth" },
  E7252: { scope: "tooth" },
  // 1.3.19: aparatología de arcada y retenedores → arch.
  D8210: { scope: "arch" },
  D8220: { scope: "arch" },
  D8680: { scope: "arch" },
  D8692: { scope: "arch" },
  E8211: { scope: "arch" },
  // 1.3.20: anestesia/sedación, conducta y servicios → general; oclusal → disfuncion; estética → estetica.
  D9110: { specialty: "anestesia" },
  D9211: { specialty: "anestesia" },
  D9212: { specialty: "anestesia" },
  D9215: { specialty: "anestesia" },
  D9220: { specialty: "anestesia" },
  D9221: { specialty: "anestesia" },
  D9230: { specialty: "anestesia" },
  D9241: { specialty: "anestesia" },
  D9242: { specialty: "anestesia" },
  D9248: { specialty: "anestesia" },
  D9910: { specialty: "prevencion" },
  D9911: { specialty: "restauradora", scope: "tooth" },
  D9914: { specialty: "general", scope: "arch" },
  D9920: { specialty: "general" },
  D9930: { specialty: "cirugia" },
  D9940: { specialty: "disfuncion", scope: "arch" },
  D9942: { specialty: "disfuncion", scope: "arch" },
  D9950: { specialty: "disfuncion" },
  D9951: { specialty: "disfuncion" },
  D9952: { specialty: "disfuncion" },
  D9970: { specialty: "estetica", scope: "tooth" },
  D9971: { specialty: "estetica", scope: "tooth" },
  D9972: { specialty: "estetica", scope: "arch" },
  D9973: { specialty: "estetica", scope: "tooth" },
  D9974: { specialty: "estetica", scope: "tooth" },
  // 1.3.21: profilaxis → prevencion; ionómero con conteo → surfaces; C3201 genérico → tooth.
  C3201: { scope: "tooth" },
  D1110: { specialty: "prevencion" },
  E2395: { scope: "surfaces", min: 1, max: 1 },
  E2396: { scope: "surfaces", min: 2, max: 2 },
  E2397: { scope: "surfaces", min: 3, max: 3 },
  E2398: { scope: "surfaces", min: 1, max: 1 },
  E2399: { scope: "surfaces", min: 2, max: 2 },
  E2400: { scope: "surfaces", min: 3, max: 3 },
  // 2.7.2: sellante «por diente» textual → tooth.
  D1351: { scope: "tooth" },
}

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
    const meta = SUBSECTION_META[row.subsection]
    if (!meta) fail(`subsección del ámbito sin metadatos: ${row.subsection}`)
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
    join(seedsDir, "treatment_templates_cpms.csv"),
    "template_key,specialty,scope,surface_count_min,surface_count_max,system_key,code,version,name",
    rows.map((r) => {
      const base = SUBSECTION_META[r.subsection]!
      const over = CODE_OVERRIDES[r.code] ?? {}
      const specialty = over.specialty ?? base.specialty
      const scope = over.scope ?? base.scope
      const min = over.min ?? null
      const max = over.max ?? null
      if (scope === "surfaces" && (min === null || max === null))
        fail(`scope surfaces sin conteo para ${r.code}`)
      if (scope !== "surfaces" && (min !== null || max !== null))
        fail(`conteo de superficies fuera de scope surfaces: ${r.code}`)
      const key = `cpms:${VERSION}:${r.code}`
      return `${key},${specialty},${scope},${min ?? ""},${max ?? ""},${SYSTEM},${r.code},${VERSION},${r.display}`
    }),
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
