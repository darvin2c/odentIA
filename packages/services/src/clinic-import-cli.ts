/**
 * La skill de carga en la terminal (ADR 0104). Corre en la máquina de quien
 * acompaña el alta, sin base de datos:
 *
 *   pnpm --filter @odentia/services import:peek -- <archivo.xlsx|.csv> [--sheet <hoja>] [--header <fila>]
 *     Las hojas (si es un Excel) y cómo es cada columna, sin mostrar datos de personas.
 *   pnpm --filter @odentia/services import:prepare -- <mapa.json> [--today AAAA-MM-DD]
 *     Escribe `plan.json` e `informe.md` junto al mapa y resume en pantalla,
 *     sin nombres ni números, lo que entra, lo que queda fuera y lo que hay que revisar.
 *   pnpm --filter @odentia/services import:carta -- <carta.json>
 *     La carta de bienvenida en PDF, junto al JSON: le pide a la clínica su lista
 *     de pacientes por correo (`clinic-import-letter.ts`).
 *   pnpm --filter @odentia/services import:clinica -- <clinica.fuente.json> [--numero N]
 *     La configuración de la clínica: de la fuente (con rutas a su logo y su hoja), el plan
 *     que carga la administración (`clinica.json`, con los archivos dentro) y el plan de
 *     carga en PDF para aprobarlo (`clinic-setup-source.ts`). Busca cada servicio en la
 *     biblioteca con su código del país.
 *   pnpm --filter @odentia/services import:informe -- <informe.json>
 *     El informe de avance de una etapa en PDF, junto al JSON, para revisarlo
 *     (`clinic-progress-report.ts`). Se envía desde la administración («Cargar
 *     datos» › «Informe a la clínica»), por el correo de producción y una sola vez.
 *   pnpm --filter @odentia/services import:dejar -- <archivo.json> --clinica <slug> [--numero N] [--pdf <archivo.pdf>]
 *     Deja `clinica.json`, `plan.json` o `informe-N.json` (con su PDF; si no se da, lo arma)
 *     como borrador en la administración, ficha del cliente › Alta, para que una persona
 *     de Administración lo apruebe (`clinic-import-drop.ts`). Con la llave de la skill,
 *     que solo deposita.
 *
 * Las rutas relativas se leen desde la carpeta donde se escribió el comando.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isZip, readXlsxRows, readZipEntries, xlsxSheetNames } from "@odentia/db/xlsx"
import { configureZodMessages } from "@odentia/clinical"
import { ZodError } from "zod"
import { WELCOME_LETTER_MAX_PAGES, welcomeLetterPdf } from "./clinic-import-letter.js"
import { checkClinicImportPlan, type ClinicImportCheck, type ClinicImportPlan } from "./clinic-import-plan.js"
import { PROGRESS_REPORT_MAX_PAGES, progressReportEmail, progressReportPdf } from "./clinic-progress-report.js"
import {
  checkDraftClinic,
  checkDraftPayload,
  DRAFT_KIND_WORDS,
  DRAFT_PDF_MAX_BYTES,
  detectDraftKind,
  draftNumber,
  draftRequestBody,
  draftsUrl,
  isPdf,
  postDraft,
  readAdminKey,
} from "./clinic-import-drop.js"
import { clinicSetupPlanSchema } from "./clinic-setup-plan.js"
import { buildClinicSetupPlan, clinicSetupPlanPdf, clinicSetupReview, loadLibrary } from "./clinic-setup-source.js"
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

/** El informe de avance en PDF, para revisarlo antes de enviarlo desde la administración. */
async function progressReport(reportPath: string): Promise<void> {
  const { bytes, pages, content } = await progressReportPdf(JSON.parse(readFileSync(reportPath, "utf-8")))
  if (pages > PROGRESS_REPORT_MAX_PAGES) {
    console.log(JSON.stringify({ escrito: null, paginas: pages, aviso: `Salió en ${pages} páginas: acorta las listas` }, null, 2))
    process.exitCode = 1
    return
  }
  const out = reportPath.replace(/\.json$/, "") + ".pdf"
  writeFileSync(out, bytes)
  const mail = progressReportEmail(content)
  console.log(JSON.stringify({ escrito: out, paginas: pages, para: content.email, asunto: mail.subject, respondeA: content.replyTo }, null, 2))
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

/** «Clínica Dental Sonrisa» → «clinica-dental-sonrisa», para el nombre del PDF. */
function fileSlug(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clinica"
}

const pagesWords = (pages: number) => `${pages} ${pages === 1 ? "página" : "páginas"}`

const seedsDir = () => resolve(dirname(fileURLToPath(import.meta.url)), "../../db/seeds")

/**
 * El PDF que acompaña el borrador cuando no se da con `--pdf`: el del plan de configuración
 * con lo de revisar de `clinica.fuente.json` (si está al lado), el del informe tal cual. El
 * plan de pacientes no lleva PDF: su informe (`informe.md`) tiene datos de personas.
 */
async function draftPdf(kind: ReturnType<typeof detectDraftKind>, payload: unknown, path: string, number: number) {
  if (kind === "plan_pacientes") return { bytes: null, note: "sin PDF" }
  if (kind === "informe") {
    const { bytes, pages } = await progressReportPdf(payload as Parameters<typeof progressReportPdf>[0])
    if (pages > PROGRESS_REPORT_MAX_PAGES) throw new Error(`El informe salió en ${pages} páginas: acorta las listas`)
    return { bytes, note: `PDF armado, ${pagesWords(pages)}` }
  }
  const plan = clinicSetupPlanSchema.parse(payload)
  const fuente = resolve(dirname(path), "clinica.fuente.json")
  const review = clinicSetupReview(existsSync(fuente) ? JSON.parse(readFileSync(fuente, "utf-8")) : {})
  const library = loadLibrary(seedsDir(), plan.product, plan.countryCode)
  const { bytes, pages } = await clinicSetupPlanPdf(plan, review, library, { number, date: clinicToday() })
  return {
    bytes,
    note: existsSync(fuente)
      ? `PDF armado, ${pagesWords(pages)}`
      : `PDF armado, ${pagesWords(pages)}, sin «Lo que llegó» ni «Para decidir» (no hay clinica.fuente.json al lado)`,
  }
}

/** `import:dejar`: sube el borrador a la administración con la llave de la skill. */
async function drop(target: string): Promise<void> {
  const slug = arg("--clinica")
  if (!slug) throw new Error("Falta --clinica <dirección de la clínica en odentIA>")
  const path = resolve(cwd, target)
  const payload: unknown = JSON.parse(readFileSync(path, "utf-8"))
  const kind = detectDraftKind(payload)
  const problems = checkDraftPayload(kind, payload)
  const otherClinic = checkDraftClinic(kind, payload, slug)
  if (otherClinic) problems.unshift(otherClinic)
  if (problems.length) {
    console.error(`${basename(path)} no se puede dejar:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
    process.exitCode = 1
    return
  }
  const number = draftNumber(kind, payload, arg("--numero"))
  const pdfArg = arg("--pdf")
  let pdf: { bytes: Uint8Array | null; note: string; filename?: string }
  if (pdfArg) {
    const bytes = readFileSync(resolve(cwd, pdfArg))
    if (!isPdf(bytes)) throw new Error(`${basename(pdfArg)} no es un PDF`)
    pdf = { bytes, note: `PDF ${basename(pdfArg)}`, filename: basename(pdfArg) }
  } else pdf = await draftPdf(kind, payload, path, number)
  if (pdf.bytes && pdf.bytes.byteLength > DRAFT_PDF_MAX_BYTES)
    throw new Error(`El PDF pasa de ${DRAFT_PDF_MAX_BYTES / 1024 / 1024} MB: achica sus imágenes`)
  // La llave se lee al final, cuando ya se sabe que el archivo sirve; nunca se imprime.
  const key = readAdminKey(process.env)
  if (key.warning) console.warn(`Aviso: ${key.warning}`)
  const url = draftsUrl(process.env)
  const result = await postDraft(url, key.key, draftRequestBody({ organizationSlug: slug, kind, number, payload, pdf: pdf.bytes, pdfFilename: pdf.filename }))
  if (!result.ok) {
    console.error(result.message)
    process.exitCode = 1
    return
  }
  console.log(
    [
      `Dejé ${DRAFT_KIND_WORDS[kind]} N.º ${number} de «${slug}» (${pdf.note}) en ${new URL(url).origin}.`,
      ...(result.data.replaced === true ? ["Reemplazó al borrador devuelto con ese mismo número."] : []),
      "Queda como borrador: nada se aprobó, cargó ni envió.",
      "Apruébalo en la administración: Clientes › ficha de la clínica › Alta («La skill dejó…»). Ahí se aprueba, se ensaya, se carga y se envía.",
    ].join("\n"),
  )
}

async function main(): Promise<void> {
  const [command, target] = process.argv.slice(2).filter((value) => value !== "--")
  if (command === "drop" && target) {
    await drop(target)
    return
  }
  if (command === "letter" && target) {
    const letterPath = resolve(cwd, target)
    const { bytes, pages, letterPages, content } = await welcomeLetterPdf(JSON.parse(readFileSync(letterPath, "utf-8")))
    const out = resolve(dirname(letterPath), `carta-${fileSlug(content.clinic)}.pdf`)
    // La carta tiene un tope de hojas: si pasa, no se escribe, se dice y el comando falla para que se acorte.
    const aviso = pages > WELCOME_LETTER_MAX_PAGES ? `Salió en ${pages} páginas: acorta el nombre de la clínica, el destinatario o quien acompaña` : undefined
    if (!aviso) writeFileSync(out, bytes)
    console.log(JSON.stringify({ escrito: aviso ? null : out, paginas: pages, hojasDeLaCarta: letterPages, buzon: content.inbox, marca: content.brandName, aviso }, null, 2))
    if (aviso) process.exitCode = 1
    return
  }
  if (command === "setup" && target) {
    const sourcePath = resolve(cwd, target)
    const { plan, review, library, problems } = buildClinicSetupPlan(sourcePath, seedsDir())
    const folder = dirname(sourcePath)
    const planPath = resolve(folder, "clinica.json")
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`)
    const number = Number(arg("--numero") ?? 1)
    const pdf = await clinicSetupPlanPdf(plan, review, library, { number, date: clinicToday() })
    const pdfPath = resolve(folder, `plan-de-carga-${number}.pdf`)
    writeFileSync(pdfPath, pdf.bytes)
    console.log(
      JSON.stringify(
        {
          escritos: [planPath, pdfPath],
          paginas: pdf.pages,
          sedes: plan.branches.length,
          servicios: plan.services.length,
          equipo: plan.team.length,
          problemas: problems,
        },
        null,
        2,
      ),
    )
    if (problems.length) process.exitCode = 1
    return
  }
  if (command === "report" && target) {
    await progressReport(resolve(cwd, target))
    return
  }
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
  console.error(
    "Uso: import:peek -- <archivo.xlsx|.csv> [--sheet <hoja>] [--header <fila>]  |  import:prepare -- <mapa.json> [--today AAAA-MM-DD]  |  import:carta -- <carta.json>  |  import:clinica -- <clinica.fuente.json>  |  import:informe -- <informe.json>  |  import:dejar -- <archivo.json> --clinica <slug> [--numero N] [--pdf <archivo.pdf>]",
  )
  process.exitCode = 2
}

// Lo que no se puede leer se dice con su motivo, sin la traza y en español.
configureZodMessages()
main().catch((error: unknown) => {
  const what = process.argv.includes("drop")
    ? "El borrador"
    : process.argv.includes("letter")
    ? "La carta"
    : process.argv.includes("report")
      ? "El informe"
      : process.argv.includes("setup")
        ? "La fuente de la clínica"
        : "El mapa"
  if (error instanceof ZodError)
    for (const issue of error.issues) console.error(`${what}: ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
  else console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
