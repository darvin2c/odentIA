/**
 * La skill de carga en la terminal (ADR 0104). Corre en la máquina de quien
 * acompaña el alta, sin base de datos:
 *
 *   pnpm --filter @odentia/services import:peek -- <archivo.xlsx|.csv> [--sheet <hoja>] [--header <fila>]
 *     Las hojas (si es un Excel) y cómo es cada columna, sin mostrar datos de personas.
 *   pnpm --filter @odentia/services import:prepare -- <mapa.json> [--today AAAA-MM-DD]
 *     Escribe `plan.json` e `informe.md` junto al mapa y resume en pantalla,
 *     sin nombres ni números, lo que entra, lo que queda fuera y lo que hay que revisar.
 *
 * Las rutas relativas se leen desde la carpeta donde se escribió el comando.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { isZip, readXlsxRows, readZipEntries, xlsxSheetNames } from "@odentia/db/xlsx"
import { ZodError } from "zod"
import { checkClinicImportPlan, type ClinicImportCheck, type ClinicImportPlan } from "./clinic-import-plan.js"
import {
  clinicImportMapSchema,
  detectDelimiter,
  type PrepareNote,
  parseCsv,
  prepareClinicImport,
  profileColumns,
} from "./clinic-import-prepare.js"

const cwd = process.env.INIT_CWD ?? process.cwd()

interface ReadFile {
  table: string[][]
  sha256: string
  /** Cómo se leyó: `xlsx`, o la codificación del CSV. */
  format: string
  sheets?: string[]
}

/**
 * El archivo tal como lo tiene la clínica: un .xlsx (la hoja pedida o la
 * primera) o un CSV, que en un Excel en español suele venir en Windows-1252.
 * El .xls de Excel 97-2003 no se lee: se guarda como .xlsx.
 */
function readTable(path: string, options: { sheet?: string; delimiter?: string } = {}): ReadFile {
  const bytes = readFileSync(path)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new Error(`${basename(path)} es un Excel antiguo (.xls): ábrelo en Excel y guárdalo como .xlsx`)
  if (isZip(bytes)) {
    const entries = readZipEntries(bytes)
    if (!entries.has("xl/workbook.xml")) throw new Error(`${basename(path)} es un .zip, no un Excel (.xlsx)`)
    return { table: readXlsxRows(entries, options.sheet), sha256, format: "xlsx", sheets: xlsxSheetNames(entries) }
  }
  let text: string
  let format = "utf-8"
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes)
    format = "windows-1252"
  }
  return { table: parseCsv(text, options.delimiter ?? detectDelimiter(text)), sha256, format }
}

/** Un mensaje sin lo que dice de una persona (lo que va entre «») ni en qué fila, para contarlo. */
function withoutData(message: string): string {
  return message.replace(/«[^»]*»/g, "«…»").replace(/fila \d+ de [^:·]+/g, "otra fila")
}

function countBy(messages: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const message of messages) counts.set(withoutData(message), (counts.get(withoutData(message)) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])
}

function cellText(value: string | number | undefined): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ")
}

function report(plan: ClinicImportPlan, check: ClinicImportCheck, notes: PrepareNote[], rows: Record<string, number>): string {
  const byKey = new Map(plan.people.map((person) => [person.key, person]))
  const where = (key: string) => {
    const origin = byKey.get(key)?.origin
    return origin ? `${origin.file}:${origin.row}` : ""
  }
  const nameOf = (key: string) => byKey.get(key)?.demographics.displayName ?? ""
  const errors = check.issues.filter((issue) => issue.level === "error")
  const avisos = check.issues.filter((issue) => issue.level === "aviso")
  const lines = [
    "# Informe de la carga",
    "",
    "Tiene datos de pacientes: no se sube al repositorio ni se envía por chat. Se borra al terminar la carga.",
    "",
    "## Resumen",
    "",
    ...Object.entries(rows).map(([file, count]) => `- ${file}: ${count} filas`),
    `- En el plan: ${plan.people.filter((person) => person.patient).length} pacientes y ${plan.people.filter((person) => !person.patient).length} personas que hablan por ellos`,
    `- Quedan fuera al preparar: ${plan.omitted.length}`,
    `- No se cargarán por errores: ${check.blocked.length}`,
    `- Para revisar: ${new Set([...avisos.map((issue) => issue.key), ...notes.filter((note) => note.level === "aviso").map((note) => note.key)]).size} filas`,
    "",
  ]
  const table = (title: string, header: string, items: string[][]) => {
    if (!items.length) return
    lines.push(`## ${title}`, "", header, `|${header.split("|").slice(1, -1).map(() => "---").join("|")}|`)
    for (const item of items) lines.push(`| ${item.map(cellText).join(" | ")} |`)
    lines.push("")
  }
  table(
    "Quedan fuera al preparar",
    "| Archivo:fila | Clave | Motivo |",
    notes.filter((note) => note.level === "fuera").map((note) => [`${note.file}:${note.row}`, note.key ?? "", note.message]),
  )
  table("No se cargarán", "| Archivo:fila | Clave | Nombre | Motivo |", errors.map((issue) => [where(issue.key), issue.key, nameOf(issue.key), issue.message]))
  table(
    "Para revisar",
    "| Archivo:fila | Clave | Nombre | Qué revisar |",
    [
      ...notes.filter((note) => note.level === "aviso").map((note) => [`${note.file}:${note.row}`, note.key ?? "", note.key ? nameOf(note.key) : "", note.message]),
      ...avisos.map((issue) => [where(issue.key), issue.key, nameOf(issue.key), issue.message]),
    ],
  )
  return lines.join("\n")
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

function clinicToday(): string {
  const given = arg("--today")
  if (given && !/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new Error("--today va como AAAA-MM-DD")
  return given ?? new Date().toISOString().slice(0, 10)
}

function main(): void {
  const [command, target] = process.argv.slice(2).filter((value) => value !== "--")
  if (command === "peek" && target) {
    const sheet = arg("--sheet")
    const header = arg("--header")
    const read = readTable(resolve(cwd, target), { sheet })
    const profile = profileColumns(read.table, header ? Number(header) : undefined)
    console.log(JSON.stringify({ file: basename(target), format: read.format, sheets: read.sheets, sheet, ...profile }, null, 2))
    return
  }
  if (command === "prepare" && target) {
    const mapPath = resolve(cwd, target)
    const folder = dirname(mapPath)
    const map = clinicImportMapSchema.parse(JSON.parse(readFileSync(mapPath, "utf-8")))
    const sources = map.files.map((file) => {
      const read = readTable(resolve(folder, file.path), { sheet: file.sheet, delimiter: file.delimiter })
      const name = file.sheet ? `${basename(file.path)} › ${file.sheet}` : basename(file.path)
      return { path: file.path, name, table: read.table, sha256: read.sha256 }
    })
    const { plan, notes, rows } = prepareClinicImport(map, sources)
    const check = checkClinicImportPlan(plan, clinicToday())
    writeFileSync(resolve(folder, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`)
    writeFileSync(resolve(folder, "informe.md"), `${report(plan, check, notes, rows)}\n`)
    console.log(
      JSON.stringify(
        {
          rows,
          plan: { pacientes: plan.people.filter((person) => person.patient).length, responsables: plan.people.filter((person) => !person.patient).length },
          fuera: countBy(notes.filter((note) => note.level === "fuera").map((note) => note.message)),
          errores: countBy(check.issues.filter((issue) => issue.level === "error").map((issue) => issue.message)),
          revisar: countBy([
            ...notes.filter((note) => note.level === "aviso").map((note) => note.message),
            ...check.issues.filter((issue) => issue.level === "aviso").map((issue) => issue.message),
          ]),
          escritos: [resolve(folder, "plan.json"), resolve(folder, "informe.md")],
        },
        null,
        2,
      ),
    )
    return
  }
  console.error("Uso: import:peek -- <archivo.xlsx|.csv> [--sheet <hoja>] [--header <fila>]  |  import:prepare -- <mapa.json> [--today AAAA-MM-DD]")
  process.exitCode = 2
}

// Lo que no se puede leer se dice con su motivo, sin la traza.
try {
  main()
} catch (error) {
  if (error instanceof ZodError)
    for (const issue of error.issues) console.error(`El mapa: ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
  else console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
