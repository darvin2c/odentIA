/**
 * Preparar el plan de carga desde los archivos de la clínica (ADR 0104). Corre
 * en la máquina de quien acompaña el alta, nunca en el servidor: lee sus
 * archivos tal como los tiene (su Excel o lo que exporta su sistema, en .xlsx
 * o CSV) con un mapa de columnas que escribe la skill de carga y devuelve el
 * plan (`clinic-import-plan.ts`) y lo que quedó fuera, fila por fila. No hace
 * falta una plantilla nuestra.
 *
 * Todo lo que transforma es determinista: el mismo archivo con el mismo mapa da
 * el mismo plan. Lo que no se puede leer con seguridad (una fecha con el año en
 * dos cifras, un sexo que el mapa no nombra) no se adivina: la fila queda fuera
 * con su motivo hasta que el mapa o una corrección lo resuelvan.
 */
import { createHash } from "node:crypto"
import {
  DOC_TYPES,
  kinshipFromWords,
  normalizePhone,
  SEX_CODES,
} from "@odentia/clinical"
import { z } from "zod"
import {
  CLINIC_IMPORT_VERSION,
  type ClinicImportDemographics,
  clinicImportDemographicsSchema,
  type ClinicImportPerson,
  type ClinicImportPlan,
  foldName,
} from "./clinic-import-plan.js"

/** Una columna del archivo, o varias que se juntan con un espacio (apellido paterno y materno). */
const columnSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])

export const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const

const fileMapSchema = z.strictObject({
  /** Ruta del archivo (.xlsx o .csv), relativa al mapa. */
  path: z.string().min(1),
  /** La hoja de un .xlsx; sin indicarla, la primera. */
  sheet: z.string().min(1).optional(),
  /**
   * En qué fila están los encabezados (desde 1). Sin indicarla, la primera
   * que trae todas las columnas del mapa: los reportes de un sistema suelen
   * llevar un título y la fecha arriba.
   */
  headerRow: z.number().int().min(1).optional(),
  /** Separador de un CSV; sin indicarlo se deduce de la primera línea (`,`, `;` o tabulador). */
  delimiter: z.enum([",", ";", "\t"]).optional(),
  /** La columna con la clave estable de cada fila (el número de historia). */
  key: z.string().min(1).optional(),
  /** Para que dos archivos con los mismos números de historia no choquen (dos sedes). */
  keyPrefix: z.string().max(20).optional(),
  columns: z.strictObject({
    givenNames: columnSchema.optional(),
    familyName: columnSchema.optional(),
    /** El nombre entero en una columna: no se separa (queda en «Faltan datos»). */
    fullName: columnSchema.optional(),
    docType: z.string().min(1).optional(),
    docNumber: z.string().min(1).optional(),
    birthDate: z.string().min(1).optional(),
    sex: z.string().min(1).optional(),
    phone: columnSchema.optional(),
    email: z.string().min(1).optional(),
    address: columnSchema.optional(),
    guardianName: columnSchema.optional(),
    guardianGivenNames: columnSchema.optional(),
    guardianFamilyName: columnSchema.optional(),
    guardianDocType: z.string().min(1).optional(),
    guardianDocNumber: z.string().min(1).optional(),
    guardianPhone: columnSchema.optional(),
    /** Parentesco escrito («Madre», «Tío»): se lee con HL7 RoleCode. */
    guardianKinship: z.string().min(1).optional(),
  }),
  /** Lo que vale para todas las filas cuando el archivo no lo trae. */
  defaults: z
    .strictObject({
      docType: z.enum(DOC_TYPES).optional(),
      guardianDocType: z.enum(DOC_TYPES).optional(),
    })
    .optional(),
  dateFormat: z.enum(DATE_FORMATS),
  /** Cómo escribe el archivo cada sexo, además de los nombres comunes. */
  sexValues: z.partialRecord(z.enum(SEX_CODES), z.array(z.string())).optional(),
  /** Cómo escribe el archivo cada tipo de documento, además de su sigla. */
  docTypeValues: z.partialRecord(z.enum(DOC_TYPES), z.array(z.string())).optional(),
  /**
   * Un teléfono que no se puede llevar a E.164 (un fijo sin código): `error`
   * deja la fila fuera; `omitir` la carga sin ese teléfono y lo dice.
   */
  invalidPhones: z.enum(["error", "omitir"]).default("error"),
})

export const clinicImportMapSchema = z.strictObject({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  files: z.array(fileMapSchema).min(1).max(20),
  /**
   * Lo que se decidió fila por fila al revisar, por clave: dejarla fuera con
   * su motivo, corregir datos (ya en su forma final: fecha ISO, tipo de
   * documento en código) o decir quién habla por ella.
   */
  overrides: z
    .record(
      z.string(),
      z.strictObject({
        skip: z.string().min(3).optional(),
        set: clinicImportDemographicsSchema.partial().optional(),
        guardian: z.strictObject({ key: z.string().min(1) }).nullable().optional(),
      }),
    )
    .default({}),
})
export type ClinicImportMap = z.infer<typeof clinicImportMapSchema>
type FileMap = ClinicImportMap["files"][number]

export interface PrepareSource {
  /** Como se nombra en el mapa (`path`). */
  path: string
  /** Nombre que queda en el plan (sin carpetas; con la hoja, si es un .xlsx). */
  name: string
  /** Sus filas tal como vienen, encabezados y títulos incluidos. */
  table: string[][]
  sha256: string
}

/** Lo que pasó con una fila al prepararla. `aviso` entra; `fuera` no entra. */
export interface PrepareNote {
  file: string
  row: number
  key?: string
  level: "fuera" | "aviso"
  message: string
}

export interface PrepareResult {
  plan: ClinicImportPlan
  notes: PrepareNote[]
  /** Filas leídas por archivo (sin el encabezado ni las vacías). */
  rows: Record<string, number>
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** El separador de un CSV: el que más aparece en la primera línea fuera de comillas. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? ""
  const outside = firstLine.replace(/"[^"]*"/g, "")
  const counts = ([",", ";", "\t"] as const).map((d) => [d, outside.split(d).length - 1] as const)
  return counts.reduce((best, item) => (item[1] > best[1] ? item : best))[0]
}

/**
 * Filas y celdas de un CSV (RFC 4180): comillas dobles, saltos dentro de
 * comillas y BOM. Las filas vacías se conservan: el número de cada fila es el
 * que ve la clínica en su archivo.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const source = text.replace(/^﻿/, "")
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell === "") quoted = true
    else if (char === delimiter) {
      row.push(cell)
      cell = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += char
  }
  if (cell !== "" || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/**
 * Cómo se ve cada columna sin mostrar sus datos: cuántas celdas tienen algo,
 * cuántos valores distintos y sus formas (`99/99/9999`, `Aa Aa`). Los valores
 * se muestran solo cuando se repiten mucho (sexo, tipo de documento), nunca
 * nombres ni números de una persona.
 */
export function profileColumns(table: string[][], headerRow = guessHeaderRow(table)) {
  const header = table[headerRow - 1] ?? []
  const body = table.slice(headerRow).filter((cells) => cells.some((value) => value.trim() !== ""))
  return {
    headerRow,
    /** Lo que hay arriba del encabezado (el título de un reporte), sin datos de personas. */
    above: table.slice(0, headerRow - 1).map((cells) => cells.filter((value) => value.trim() !== "").length),
    rows: body.length,
    columns: header.map((name, index) => {
      const values = body.map((cells) => (cells[index] ?? "").trim()).filter(Boolean)
      const distinct = new Map<string, number>()
      const shapes = new Map<string, number>()
      for (const value of values) {
        distinct.set(value, (distinct.get(value) ?? 0) + 1)
        const shape = shapeOf(value)
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
      }
      const repeated = distinct.size <= 12 && distinct.size * 5 <= values.length
      return {
        name: name.trim(),
        filled: values.length,
        distinct: distinct.size,
        shapes: [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 4),
        ...(repeated ? { values: [...distinct].sort((a, b) => b[1] - a[1]) } : {}),
      }
    }),
  }
}

/**
 * La fila que parece el encabezado, para mirar un archivo antes de tener mapa:
 * entre las 30 primeras, la primera con tantas celdas llenas como la más
 * llena y todas con letras (un título o una fecha de reporte tienen menos
 * celdas; una fila de datos trae números).
 */
export function guessHeaderRow(table: string[][]): number {
  const top = table.slice(0, 30).map((cells) => cells.filter((value) => value.trim() !== ""))
  const widest = Math.max(0, ...top.map((cells) => cells.length))
  const at = top.findIndex((cells) => cells.length === widest && cells.every((value) => /\p{L}/u.test(value)))
  return at >= 0 ? at + 1 : 1
}

/**
 * La fila de encabezados según el mapa: la indicada o la primera que trae
 * todas sus columnas. Si ninguna, dice cuáles faltan en la más parecida.
 */
export function findHeaderRow(table: string[][], columns: string[], given?: number): number {
  const has = (row: number) => {
    const names = new Set((table[row - 1] ?? []).map((value) => value.trim()))
    return columns.filter((column) => !names.has(column))
  }
  if (given) {
    const missing = has(given)
    if (missing.length) throw new Error(`La fila ${given} no tiene la columna «${missing[0]}»`)
    return given
  }
  let best = { row: 1, missing: columns }
  for (let row = 1; row <= Math.min(table.length, 30); row++) {
    const missing = has(row)
    if (!missing.length) return row
    if (missing.length < best.missing.length) best = { row, missing }
  }
  throw new Error(`No hay una fila con todas las columnas del mapa; en la fila ${best.row} falta «${best.missing[0]}»`)
}

/** La forma de un valor: cada dígito es 9 y cada tramo de letras, A (mayúsculas) o a. */
export function shapeOf(value: string): string {
  return value
    .replace(/\d/g, "9")
    .replace(/\p{Lu}+/gu, "A")
    .replace(/\p{Ll}+/gu, "a")
    .replace(/(Aa)+/g, "Aa")
    .slice(0, 40)
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "do", "dos", "das", "van", "von"])

/** Un nombre escrito todo en mayúsculas se lleva a mayúscula inicial; lo demás queda como está. */
export function tidyName(value: string): string {
  const clean = value.trim().replace(/\s+/g, " ")
  if (!clean || /\p{Ll}/u.test(clean)) return clean
  return clean
    .toLowerCase()
    .split(" ")
    .map((word, index) =>
      index > 0 && PARTICLES.has(word) ? word : word.replace(/(^|[-'])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase()),
    )
    .join(" ")
}

/** Días desde el 30/12/1899: así guarda Excel una fecha cuando la columna es numérica. */
function excelSerialDate(serial: number): string {
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
  return date.toISOString().slice(0, 10)
}

/** Una fecha del archivo en ISO, o el motivo por el que no se puede leer. */
export function readDate(raw: string, format: (typeof DATE_FORMATS)[number]): { value: string } | { error: string } {
  const value = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { value }
  // Con decimales, la hora del día: se queda la fecha.
  if (/^\d{5}(\.\d+)?$/.test(value)) return { value: excelSerialDate(Math.floor(Number(value))) }
  const parts = value.split(/[/.-]/)
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part)))
    return { error: `La fecha «${value}» no tiene la forma ${format}` }
  const [a, b, c] = parts as [string, string, string]
  const [day, month, year] = format === "DD/MM/YYYY" ? [a, b, c] : format === "MM/DD/YYYY" ? [b, a, c] : [c, b, a]
  if (year.length !== 4) return { error: `La fecha «${value}» tiene el año en ${year.length} cifras: no se sabe el siglo` }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  const date = new Date(`${iso}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    return { error: `La fecha «${value}» no existe en el calendario (${format})` }
  return { value: iso }
}

/** `9.87654321E8`: así deja Excel un número largo en una columna numérica. */
function fromScientific(value: string): string {
  return /^\d+(\.\d+)?e\+?\d+$/i.test(value) ? BigInt(Math.round(Number(value))).toString() : value
}

/**
 * El primer teléfono de la celda que se puede llevar a E.164 (una celda puede
 * traer dos: «987654321 / 014567890»). `others`: cuántos más había.
 */
export function readPhone(raw: string, countryCode: string): { phone: string | null; invalid: string[]; others: number } {
  const parts = raw
    .split(/\s*(?:[/,;|]|\s-\s|\sy\s|\so\s)\s*/i)
    .map((part) => fromScientific(part.trim()))
    .filter(Boolean)
  const valid = parts.map((part) => normalizePhone(part, countryCode))
  const first = valid.findIndex(Boolean)
  return {
    phone: first >= 0 ? valid[first]! : null,
    invalid: parts.filter((_, index) => !valid[index]),
    others: first >= 0 ? valid.filter(Boolean).length - 1 : 0,
  }
}

const SEX_WORDS: Record<(typeof SEX_CODES)[number], string[]> = {
  M: ["m", "masculino", "hombre", "h", "varon", "masc"],
  F: ["f", "femenino", "mujer", "fem"],
  I: [],
  D: [],
}
const DOC_WORDS: Partial<Record<(typeof DOC_TYPES)[number], string[]>> = {
  DNI: ["dni", "d.n.i.", "d.n.i"],
  CE: ["ce", "c.e.", "carne de extranjeria", "carnet de extranjeria"],
  PASAPORTE: ["pasaporte", "pas", "pasaporte extranjero"],
  CNV: ["cnv", "certificado de nacido vivo"],
}

function lookup<T extends string>(raw: string, words: Partial<Record<T, string[]>>, extra?: Partial<Record<T, string[]>>): T | null {
  const value = foldName(raw)
  for (const source of [extra, words]) {
    for (const [code, list] of Object.entries(source ?? {}) as Array<[T, string[]]>) {
      if (code.toLowerCase() === value || list.some((word) => foldName(word) === value)) return code
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function contentKey(parts: Array<string | null | undefined>): string {
  return `h-${createHash("sha256").update(parts.map((part) => part ?? "").join("|")).digest("hex").slice(0, 12)}`
}

/**
 * Arma el plan con el mapa y los archivos ya leídos. La clave de cada fila es
 * la de su columna (con el prefijo del archivo); sin columna de clave, una
 * huella de su nombre, nacimiento y documento, que no cambia si el archivo se
 * reordena.
 */
export function prepareClinicImport(map: ClinicImportMap, sources: PrepareSource[]): PrepareResult {
  const notes: PrepareNote[] = []
  const rows: Record<string, number> = {}
  const people: ClinicImportPerson[] = []
  const omitted: ClinicImportPlan["omitted"] = []
  const guardians = new Map<string, ClinicImportPerson>()
  const patientByDoc = new Map<string, string>()
  const byKey = new Map<string, ClinicImportPerson>()

  for (const file of map.files) {
    const source = sources.find((item) => item.path === file.path)
    if (!source) throw new Error(`Falta el archivo ${file.path}`)
    const headerRow = findHeaderRow(source.table, mappedColumns(file), file.headerRow)
    const index = new Map((source.table[headerRow - 1] ?? []).map((name, i) => [name.trim(), i]))
    const cell = (cells: string[], column: string | string[] | undefined): string =>
      (Array.isArray(column) ? column : column ? [column] : [])
        .map((name) => (cells[index.get(name) ?? -1] ?? "").trim())
        .filter(Boolean)
        .join(" ")
    rows[source.name] = 0

    for (const [offset, cells] of source.table.slice(headerRow).entries()) {
      // La fila como la ve la clínica en su archivo; las vacías cuentan para el número, no para el total.
      const row = headerRow + offset + 1
      if (!cells.some((value) => value.trim() !== "")) continue
      rows[source.name]!++
      const out = (message: string, key?: string) => {
        notes.push({ file: source.name, row, ...(key ? { key } : {}), level: "fuera", message })
        omitted.push({ file: source.name, row, reason: message })
      }
      const aviso = (message: string, key?: string) => notes.push({ file: source.name, row, ...(key ? { key } : {}), level: "aviso", message })

      const read = readPersonCells(file, map.countryCode, {
        givenNames: cell(cells, file.columns.givenNames),
        familyName: cell(cells, file.columns.familyName),
        fullName: cell(cells, file.columns.fullName),
        docType: cell(cells, file.columns.docType),
        docNumber: cell(cells, file.columns.docNumber),
        birthDate: cell(cells, file.columns.birthDate),
        sex: cell(cells, file.columns.sex),
        phone: cell(cells, file.columns.phone),
        email: cell(cells, file.columns.email),
        address: cell(cells, file.columns.address),
      }, file.defaults?.docType)
      const ownKey = file.key ? cell(cells, file.key) : ""
      const key = ownKey
        ? `${file.keyPrefix ?? ""}${ownKey}`
        : contentKey([read.demographics.displayName && foldName(read.demographics.displayName), read.demographics.birthDate, read.demographics.docNumber])
      if (file.key && !ownKey) {
        out(`Sin valor en la columna de clave «${file.key}»`)
        continue
      }
      const override = map.overrides[key]
      if (override?.skip) {
        out(`Se dejó fuera: ${override.skip}`, key)
        continue
      }
      const problems = [...read.problems]
      let demographics = read.demographics
      if (override?.set) {
        demographics = { ...demographics, ...override.set }
        for (const field of Object.keys(override.set)) {
          const at = problems.findIndex((problem) => problem.field === field)
          if (at >= 0) problems.splice(at, 1)
        }
      }
      if (!demographics.displayName) {
        out("Sin nombre", key)
        continue
      }
      const blocking = problems.filter((problem) => problem.level === "fuera")
      if (blocking.length) {
        out(blocking.map((problem) => problem.message).join(" · "), key)
        continue
      }
      // Lo que exporta un sistema suele traer una fila por cita o por tratamiento: la misma
      // persona (misma clave, nombre, nacimiento y documento) se toma una vez y completa lo vacío.
      const first = byKey.get(key)
      if (first && sameIdentity(first.demographics, demographics)) {
        for (const [field, value] of Object.entries(demographics) as Array<[keyof ClinicImportDemographics, string | null]>)
          if (value && !first.demographics[field]) Object.assign(first.demographics, { [field]: value })
        out(`Es la misma persona de la fila ${first.origin?.row} de ${first.origin?.file}: se toma una vez`, key)
        continue
      }
      for (const problem of problems) aviso(problem.message, key)

      const person: ClinicImportPerson = { key, patient: true, demographics, origin: { file: source.name, row } }
      people.push(person)
      if (!first) byKey.set(key, person)
      const doc = docKey(demographics)
      if (doc) patientByDoc.set(doc, key)

      // Quien habla por ella, si el archivo lo trae: otra persona, sin ficha.
      if (override?.guardian !== undefined) {
        if (override.guardian) person.guardian = { key: override.guardian.key, relationship: "guardian" }
        continue
      }
      const guardian = readPersonCells(file, map.countryCode, {
        givenNames: cell(cells, file.columns.guardianGivenNames),
        familyName: cell(cells, file.columns.guardianFamilyName),
        fullName: cell(cells, file.columns.guardianName),
        docType: cell(cells, file.columns.guardianDocType),
        docNumber: cell(cells, file.columns.guardianDocNumber),
        birthDate: "",
        sex: "",
        phone: cell(cells, file.columns.guardianPhone),
        email: "",
        address: "",
      }, file.defaults?.guardianDocType)
      if (!guardian.demographics.displayName) continue
      const guardianBlocking = guardian.problems.filter((problem) => problem.level === "fuera")
      if (guardianBlocking.length) {
        aviso(`Quien habla por ella no se carga: ${guardianBlocking.map((problem) => problem.message).join(" · ")}`, key)
        continue
      }
      for (const problem of guardian.problems) aviso(`De quien habla por ella: ${problem.message}`, key)
      const kinship = kinshipFromWords(cell(cells, file.columns.guardianKinship))
      const guardianDoc = docKey(guardian.demographics)
      const guardianKey = guardianDoc ? `responsable/${guardianDoc}` : `${key}/responsable`
      person.guardian = { key: guardianKey, relationship: "guardian", ...(kinship ? { kinship } : {}) }
      if (!guardians.has(guardianKey))
        guardians.set(guardianKey, { key: guardianKey, patient: false, demographics: guardian.demographics, origin: { file: source.name, row } })
    }
  }

  // Si quien habla por ella también es paciente (mismo documento), es esa misma ficha.
  for (const person of people) {
    const guardianKey = person.guardian?.key
    if (!guardianKey?.startsWith("responsable/")) continue
    const patientKey = patientByDoc.get(guardianKey.slice("responsable/".length))
    if (patientKey && patientKey !== person.key) person.guardian = { ...person.guardian!, key: patientKey }
  }
  const referenced = new Set(people.map((person) => person.guardian?.key).filter(Boolean))
  for (const [key, guardian] of guardians) {
    const override = map.overrides[key]
    if (!referenced.has(key)) continue
    if (override?.skip) {
      notes.push({ file: guardian.origin!.file, row: guardian.origin!.row, key, level: "fuera", message: `Se dejó fuera: ${override.skip}` })
      for (const person of people) if (person.guardian?.key === key) delete person.guardian
      continue
    }
    if (override?.set) guardian.demographics = { ...guardian.demographics, ...override.set }
    people.unshift(guardian)
  }

  return {
    plan: {
      version: CLINIC_IMPORT_VERSION,
      countryCode: map.countryCode,
      sources: sources.map((source) => ({ name: source.name, sha256: source.sha256 })),
      people,
      omitted,
    },
    notes,
    rows,
  }
}

function mappedColumns(file: FileMap): string[] {
  const names = Object.values(file.columns).flatMap((column) => (Array.isArray(column) ? column : [column]))
  return [...(file.key ? [file.key] : []), ...names.filter((name): name is string => !!name)]
}

/** La misma persona en dos filas: mismo nombre, y nacimiento y documento que no se contradicen. */
function sameIdentity(a: ClinicImportDemographics, b: ClinicImportDemographics): boolean {
  const agrees = (x: string | null | undefined, y: string | null | undefined) => !x || !y || x === y
  return foldName(a.displayName) === foldName(b.displayName) && agrees(a.birthDate, b.birthDate) && agrees(a.docNumber, b.docNumber)
}

function docKey(demographics: ClinicImportDemographics): string | null {
  return demographics.docType && demographics.docNumber ? `${demographics.docType}-${demographics.docNumber.toUpperCase()}` : null
}

interface CellProblem {
  level: "fuera" | "aviso"
  field?: string
  message: string
}

/** Las celdas de una persona, ya en la forma del plan, con lo que no se pudo leer. */
function readPersonCells(
  file: FileMap,
  countryCode: string,
  raw: Record<"givenNames" | "familyName" | "fullName" | "docType" | "docNumber" | "birthDate" | "sex" | "phone" | "email" | "address", string>,
  defaultDocType: (typeof DOC_TYPES)[number] | undefined,
): { demographics: ClinicImportDemographics; problems: CellProblem[] } {
  const problems: CellProblem[] = []
  const givenNames = tidyName(raw.givenNames) || null
  const familyName = tidyName(raw.familyName) || null
  const displayName = [givenNames, familyName].filter(Boolean).join(" ") || tidyName(raw.fullName)

  let docType: (typeof DOC_TYPES)[number] | null = null
  let docNumber: string | null = raw.docNumber.replace(/[\s.]/g, "") || null
  if (docNumber) {
    docType = raw.docType ? lookup(raw.docType, DOC_WORDS, file.docTypeValues) : (defaultDocType ?? null)
    if (raw.docType && !docType) problems.push({ level: "fuera", field: "docType", message: `El tipo de documento «${raw.docType}» no está en el mapa` })
    if (!raw.docType && !docType) problems.push({ level: "fuera", field: "docType", message: "Hay número de documento pero no su tipo" })
    // Excel quita el cero de adelante de un DNI que guarda como número.
    if (docType === "DNI" && /^\d{7}$/.test(docNumber)) {
      docNumber = `0${docNumber}`
      problems.push({ level: "aviso", field: "docNumber", message: "Al DNI le faltaba el cero de adelante (Excel lo quita): se completó" })
    }
  }

  let birthDate: string | null = null
  if (raw.birthDate) {
    const date = readDate(raw.birthDate, file.dateFormat)
    if ("error" in date) problems.push({ level: "fuera", field: "birthDate", message: date.error })
    else birthDate = date.value
  }

  let sex: (typeof SEX_CODES)[number] | null = null
  if (raw.sex) {
    sex = lookup(raw.sex, SEX_WORDS, file.sexValues)
    if (!sex) problems.push({ level: "fuera", field: "sex", message: `El sexo «${raw.sex}» no está en el mapa` })
  }

  let phone: string | null = null
  if (raw.phone) {
    const read = readPhone(raw.phone, countryCode)
    phone = read.phone
    if (!phone) {
      const message = `El teléfono «${raw.phone}» no se puede llevar al formato internacional`
      problems.push(file.invalidPhones === "omitir" ? { level: "aviso", field: "phone", message: `${message}: se carga sin teléfono` } : { level: "fuera", field: "phone", message })
    } else if (read.others || read.invalid.length) {
      problems.push({ level: "aviso", field: "phone", message: "Tenía más de un teléfono: se tomó el primero que se puede usar" })
    }
  }

  return {
    demographics: {
      displayName,
      givenNames,
      familyName,
      birthDate,
      docType,
      docNumber,
      sex,
      phone,
      email: raw.email.toLowerCase() || null,
      address: raw.address.replace(/\s+/g, " ") || null,
    },
    problems,
  }
}
