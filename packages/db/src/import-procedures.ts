/**
 * Importación reproducible de las listas oficiales de procedimientos COMPLETAS
 * (ADR 0079, entrega 7) a los seeds versionados de `seeds/`: cada código con
 * su denominación íntegra y la sección donde lo pone el publicador.
 *
 * Uso: `pnpm --filter @odentia/db import:procedures [LISTA=ruta-local …]`
 * (p. ej. `CPMS=C:/tmp/cpms-oficial.xlsx CUPS=./resolucion-2706-de-2025.zip`).
 * Una lista sin ruta se descarga de su fuente oficial. Toda fuente se verifica
 * con su SHA-256 antes de leerla (fail closed).
 *
 * Qué es un código en cada archivo (lo reportable, nunca los títulos):
 * - CPMS (RM-550-2023-MINSA, Anexo N.° 1, hoja «Parte 1»): cada fila con
 *   código; sección «1.3», «2.7»…
 * - CUPS (Res. 2706 de 2025, Anexo Técnico 2 sin puntos): los códigos de seis
 *   dígitos; sección = su capítulo («23»).
 * - CIE-9-MC de la DGIS (feb. 2024): las rúbricas de nivel 1 (`POR_NIVELA`);
 *   sección = `CAPITULO`.
 * - FONASA MLE 2026: las prestaciones (`titulo` 5, sin correlativo); el código
 *   es grupo + subgrupo + prestación; sección = el grupo.
 *
 * Cada producto dice sus códigos en `seeds/procedure_code_products.csv`, a
 * mano: el importador no los elige, solo comprueba que sigan existiendo. Las
 * listas que no se importan de aquí (Colegio de Costa Rica y CIE-9-MC de El
 * Salvador) conservan sus CSV.
 *
 * Denominaciones: se recortan y los espacios repetidos o saltos de línea
 * pasan a un espacio; nada más se cambia.
 *
 * Salida determinista (orden por código, LF, UTF-8 sin BOM, newline final):
 * `seeds/procedure_codes_<lista>.csv` y sus filas de
 * `seeds/procedure_catalog_release.csv` (las demás se conservan).
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import xlsx from "xlsx"
import { codesFileOf } from "./procedure-codes.js"

const here = dirname(fileURLToPath(import.meta.url))
const seedsDir = join(here, "..", "seeds")

interface OfficialCode {
  code: string
  section: string
  display: string
}

interface Source {
  version: string
  scope: string
  url: string
  sha256: string
  parse: (buf: Buffer) => OfficialCode[]
}

function fail(msg: string): never {
  throw new Error(`import-procedures: ${msg}`)
}

function clean(cell: unknown): string {
  if (cell === null || cell === undefined) return ""
  return String(cell).replaceAll(" ", " ").replace(/\s+/g, " ").trim()
}

function sheet(buf: Buffer, name: string): unknown[][] {
  const ws = xlsx.read(buf, { type: "buffer" }).Sheets[name]
  if (!ws) fail(`hoja «${name}» no encontrada en el archivo oficial`)
  return xlsx.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null })
}

function expectHeader(
  row: unknown[] | undefined,
  expected: Record<number, string>,
  list: string,
): void {
  for (const [index, name] of Object.entries(expected)) {
    if (clean(row?.[Number(index)]) !== name)
      fail(`${list}: cabecera oficial inesperada: ${JSON.stringify(row)}`)
  }
}

const SOURCES: Record<string, Source> = {
  CPMS: {
    version: "RM-550-2023-MINSA",
    scope: "completa: Anexo N.° 1 (Parte 1)",
    url: "https://cdn.www.gob.pe/uploads/document/file/4660631/Parte%201%20050623%20Anexo%20Nro.%201%20Listado%20de%20Procedimientos%20M%C3%A9dicos%20y%20Sanitarios%20ok15.xlsx?v=1686924375",
    sha256: "cc71b2200e86638f3cd21acf0e133930b8182ca719eb8297091ef58675956d7a",
    parse(buf) {
      const grid = sheet(buf, "Parte 1")
      expectHeader(grid[1], { 1: "Código grupo", 7: "Código de procedimiento" }, "CPMS")
      return grid
        .slice(2)
        .filter((line) => clean(line?.[7]))
        .map((line) => ({ code: clean(line[7]), section: clean(line[3]), display: clean(line[8]) }))
    },
  },
  CUPS: {
    version: "RES-2706-2025",
    scope: "completa: Anexo Técnico 2 (códigos de seis dígitos)",
    url: "https://www.minsalud.gov.co/sites/rid/Lists/BibliotecaDigital/RIDE/DE/DIJ/resolucion-2706-de-2025.zip",
    sha256: "2cd7597b9cb5860e8c947a5165daa91dd8dfd80c0c3f4c300b93cd141e8a2fc1",
    parse(zip) {
      const name = "Anexos tecnicos Resolucion 2706 de 2025_23122025.xlsx"
      const entry = xlsx.CFB.find(xlsx.CFB.read(zip, { type: "buffer" }), name)
      if (!entry?.content) fail(`CUPS: «${name}» no está en el ZIP oficial`)
      const grid = sheet(Buffer.from(entry.content as Uint8Array), "ANEXO 2 SIN PUNTOS (.)")
      expectHeader(grid[1], { 0: "CÓDIGO", 1: "DESCRIPCIÓN" }, "CUPS")
      const out: OfficialCode[] = []
      let chapter = ""
      for (const line of grid.slice(2)) {
        const first = clean(line?.[0])
        const title = /^Capítulo (\d+) /.exec(first)
        if (title) chapter = title[1] ?? ""
        else if (/^\d{6}$/.test(first)) {
          if (!chapter) fail(`CUPS: código ${first} antes de su capítulo`)
          out.push({ code: first, section: chapter, display: clean(line[1]) })
        }
      }
      return out
    },
  },
  "CIE9MC-MX": {
    version: "DGIS-2024-02",
    scope: "completa: rúbricas de nivel 1 de la lista tabular",
    url: "https://gobi.salud.gob.mx/gobi/catalogos/catalogosmaestros/PROCEDIMIENTO_202402.xlsx",
    sha256: "da082b9e036e5e8a219f33f888b0de2b459d93fff4c631627a3ce51b55ee5829",
    parse(buf) {
      const grid = sheet(buf, "Catálogo-CIE9MC")
      expectHeader(
        grid[0],
        { 1: "CAPITULO", 2: "CATALOG_KEY", 3: "PRO_NOMBRE", 14: "POR_NIVELA" },
        "CIE9MC-MX",
      )
      return grid
        .slice(1)
        .filter((line) => line?.[14] === 1)
        .map((line) => ({ code: clean(line[2]), section: clean(line[1]), display: clean(line[3]) }))
    },
  },
  FONASA: {
    version: "ARANCEL-MLE-2026",
    scope: "completa: prestaciones de la Modalidad Libre Elección",
    url: "https://www.fonasa.gob.cl/wp-content/uploads/sites/3/2026/03/2-Planilla-MLE-2026.xlsx",
    sha256: "3172003f36112554df94359f958f8a4e0f8ca6e13b860118a3875662025ef269",
    parse(buf) {
      const grid = sheet(buf, "Sheet1")
      expectHeader(
        grid[0],
        { 1: "grupo", 2: "sub_grupo", 3: "presta", 4: "corr", 5: "titulo", 14: "glosa" },
        "FONASA",
      )
      return grid
        .slice(1)
        .filter((line) => clean(line?.[5]) === "5" && clean(line?.[4]) === "0000")
        .map((line) => ({
          code: `${clean(line[1])}${clean(line[2])}${clean(line[3])}`,
          section: clean(line[1]),
          display: clean(line[14]),
        }))
    },
  },
}

async function loadSource(
  list: string,
  source: Source,
  localPath: string | undefined,
): Promise<Buffer> {
  let buf: Buffer
  if (localPath) buf = readFileSync(localPath)
  else {
    const res = await fetch(source.url)
    if (!res.ok) fail(`${list}: descarga oficial falló: HTTP ${res.status}`)
    buf = Buffer.from(await res.arrayBuffer())
  }
  const sha = createHash("sha256").update(buf).digest("hex")
  if (sha !== source.sha256)
    fail(`${list}: SHA-256 no coincide: esperado ${source.sha256}, obtenido ${sha}`)
  return buf
}

function checked(list: string, codes: OfficialCode[]): OfficialCode[] {
  if (codes.length === 0) fail(`${list}: ningún código leído`)
  const seen = new Set<string>()
  for (const c of codes) {
    if (!c.code || !c.section || !c.display)
      fail(`${list}: código sin sección o denominación: ${JSON.stringify(c)}`)
    if (/[,":\s]/.test(c.code) || /[,\s]/.test(c.section))
      fail(`${list}: carácter inseguro en ${c.code}`)
    if (seen.has(c.code)) fail(`${list}: código duplicado ${c.code}`)
    seen.add(c.code)
  }
  return [...codes].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

function writeCsv(file: string, header: string, lines: string[]): void {
  writeFileSync(join(seedsDir, file), `${header}\n${lines.join("\n")}\n`, { encoding: "utf8" })
}

async function main(): Promise<void> {
  const paths = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const [list, path] = arg.split(/=(.*)/s)
    if (!list || !path || !SOURCES[list])
      fail(`argumento inválido «${arg}»: usa LISTA=ruta con ${Object.keys(SOURCES).join(", ")}`)
    paths.set(list, path)
  }
  const releaseFile = "procedure_catalog_release.csv"
  const releaseHeader =
    "system_key,version,scope,source_url,source_sha256,expected_count,is_current"
  const releases = readFileSync(join(seedsDir, releaseFile), "utf8")
    .split("\n")
    .slice(1)
    .filter(Boolean)
  const imported = new Map<string, string>()
  for (const [list, source] of Object.entries(SOURCES)) {
    // El ámbito va en medio de una fila CSV sin comillas.
    if (source.scope.includes(",")) fail(`${list}: el ámbito no puede llevar comas`)
    const codes = checked(list, source.parse(await loadSource(list, source, paths.get(list))))
    writeCsv(
      codesFileOf(list),
      "system_key,code,version,section,display",
      codes.map((c) => `${list},${c.code},${source.version},${c.section},${c.display}`),
    )
    imported.set(
      list,
      `${list},${source.version},${source.scope},${source.url},${source.sha256},${codes.length},true`,
    )
    console.log(`import-procedures: ${list} ${codes.length} códigos (${source.version})`)
  }
  writeCsv(
    releaseFile,
    releaseHeader,
    releases.map((line) => imported.get(line.slice(0, line.indexOf(","))) ?? line),
  )
}

await main()
