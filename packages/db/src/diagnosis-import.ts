import { createHash } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import {
  type DiagnosisSystemKey,
  diagnosisSearchText,
  isDiagnosisCodeFormat,
  normalizeDiagnosisCode,
} from "@odentia/clinical"

/**
 * Lectura de los archivos de una lista de diagnósticos (ADR 0041), sin base de
 * datos: CSV o TSV con comillas dobles (RFC 4180) y un solo separador por
 * archivo, que se decide con el encabezado; o ClaML (ISO 13120), el XML en
 * que la OMS publica la CIE-10. Acepta los códigos con † y * y los que vienen
 * sin punto («K021»), y la tabulación de la CIE-11 de la OMS (columnas
 * «Code», «Title», «ClassKind», «ChapterNo» y la URI de la linealización),
 * también dentro del .zip tal como se descarga.
 */

export interface DiagnosisSourceRow {
  code: string
  title: string
  uri: string | null
}

export interface DiagnosisCatalogRow extends DiagnosisSourceRow {
  isCategory: boolean
  searchText: string
}

/** Falla si los bytes no son los publicados: un archivo distinto no entra. */
export function assertSha256(bytes: Uint8Array, expected: string | undefined): string {
  const want = expected?.trim().toLowerCase()
  if (!want) throw new Error("Falta el SHA-256 del archivo publicado: sin él no se carga nada")
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error("El SHA-256 tiene 64 caracteres hexadecimales")
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== want)
    throw new Error(`El archivo no coincide con el publicado (su SHA-256 es ${actual})`)
  return actual
}

/** El separador del archivo: el que más aparece en el encabezado, fuera de comillas. */
function detectSeparator(headerLine: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 }
  let quoted = false
  for (const char of headerLine) {
    if (char === '"') quoted = !quoted
    else if (!quoted && char in counts) counts[char]! += 1
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!
  return best[1] > 0 ? best[0] : ","
}

/**
 * Filas de un CSV con comillas dobles: un campo entre comillas puede llevar
 * el separador, saltos de línea y comillas escritas dos veces («""»).
 */
export function parseDelimited(text: string): string[][] {
  const body = text.replace(/^﻿/, "")
  const firstLineEnd = body.search(/\r?\n/)
  const separator = detectSeparator(firstLineEnd < 0 ? body : body.slice(0, firstLineEnd))
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let i = 0
  while (i < body.length) {
    const char = body[i]!
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }
    if (char === '"' && field.trim() === "") {
      quoted = true
      field = ""
      i += 1
      continue
    }
    if (char === separator) {
      row.push(field)
      field = ""
      i += 1
      continue
    }
    if (char === "\r" || char === "\n") {
      row.push(field)
      if (row.some((cell) => cell.trim() !== "")) rows.push(row)
      row = []
      field = ""
      i += char === "\r" && body[i + 1] === "\n" ? 2 : 1
      continue
    }
    field += char
    i += 1
  }
  if (quoted) throw new Error("El archivo termina con unas comillas sin cerrar")
  row.push(field)
  if (row.some((cell) => cell.trim() !== "")) rows.push(row)
  return rows
}

function headerKey(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase()
}
const CODE_HEADERS = new Set(["code", "codigo", "cod", "clave"])
const TITLE_HEADERS = new Set(["description", "descripcion", "title", "titulo", "nombre"])
const URI_HEADERS = ["linearization (release) uri", "linearization uri", "uri", "foundation uri"]
const KIND_HEADERS = new Set(["classkind", "class kind", "kind"])
/** Título oficial en inglés de la tabulación de la CIE-11, solo para lo que la traducción no trae. */
const ENGLISH_TITLE_HEADERS = new Set(["titleen", "title en"])
const CHAPTER_HEADERS = new Set(["chapterno", "chapter no", "chapter"])
/**
 * Capítulos de la CIE-11 que se cargan: del 01 al 25, los que se registran
 * solos como diagnóstico. Quedan fuera, según la guía de referencia de la OMS:
 * el X, porque los códigos de extensión «nunca se usan sin un código
 * principal» (§2.9); el 26, porque la medicina tradicional se usa «junto con»
 * los capítulos 01–25 (§2.23.22), y la sección V, que evalúa el funcionamiento
 * y no es una afección (§2.11). Lo que se carga va completo, con su código,
 * título y URI sin cambios (licencia de la CIE-11, cláusulas 1.2.2 y 1.2.3).
 */
const ICD11_REGISTRABLE_CHAPTER = /^(0[1-9]|1\d|2[0-5])$/

/** Filas de un CSV o TSV con encabezado (código y título; URI y tipo de clase si los trae). */
export function parseDiagnosisDelimited(text: string): DiagnosisSourceRow[] {
  const [header, ...lines] = parseDelimited(text)
  if (!header) throw new Error("El archivo está vacío")
  const keys = header.map(headerKey)
  const codeAt = keys.findIndex((key) => CODE_HEADERS.has(key))
  const titleAt = keys.findIndex((key) => TITLE_HEADERS.has(key))
  const uriAt = URI_HEADERS.map((name) => keys.indexOf(name)).find((at) => at >= 0) ?? -1
  const kindAt = keys.findIndex((key) => KIND_HEADERS.has(key))
  const englishAt = keys.findIndex((key) => ENGLISH_TITLE_HEADERS.has(key))
  const chapterAt = kindAt >= 0 ? keys.findIndex((key) => CHAPTER_HEADERS.has(key)) : -1
  if (codeAt < 0 || titleAt < 0)
    throw new Error(
      `Encabezado inesperado: ${header.join(" | ")} (se espera el código y la descripción)`,
    )
  // La tabulación antepone un guion por nivel de profundidad («- - Caries dental»): no es parte del título.
  const cleanTitle = (value: string | undefined) => (value ?? "").trim().replace(/^(-\s*)+/, "").trim()
  const rows: DiagnosisSourceRow[] = []
  lines.forEach((cells, index) => {
    const code = (cells[codeAt] ?? "").trim()
    // La tabulación de la CIE-11 trae capítulos y bloques sin código: solo cuentan las categorías.
    if (kindAt >= 0 && (cells[kindAt] ?? "").trim().toLowerCase() !== "category") return
    if (chapterAt >= 0 && !ICD11_REGISTRABLE_CHAPTER.test((cells[chapterAt] ?? "").trim())) return
    if (!code) throw new Error(`Fila ${index + 2}: falta el código`)
    // La edición en español deja sin traducir unos pocos títulos (dos en 2026-01, QA47.6 y
    // QA47.7): se guarda el título oficial en inglés del mismo archivo, nunca uno inventado.
    const title = cleanTitle(cells[titleAt]) || (englishAt >= 0 ? cleanTitle(cells[englishAt]) : "")
    const uri = uriAt >= 0 ? (cells[uriAt] ?? "").trim() || null : null
    rows.push({ code, title, uri })
  })
  return rows
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&")
}

/**
 * Las categorías de un archivo ClaML: cada `<Class kind="category">` con su
 * código y su rúbrica `preferred` (en `language` si el archivo trae varias).
 * Capítulos y bloques no se cargan.
 */
export function parseClaml(text: string, language = "es"): DiagnosisSourceRow[] {
  const rows: DiagnosisSourceRow[] = []
  const classRe = /<Class\b([^>]*)>([\s\S]*?)<\/Class>/g
  for (const match of text.matchAll(classRe)) {
    const attrs = match[1] ?? ""
    const kind = /\bkind="([^"]*)"/.exec(attrs)?.[1]
    if (kind !== "category") continue
    const code = /\bcode="([^"]*)"/.exec(attrs)?.[1]
    if (!code) continue
    const body = match[2] ?? ""
    let title: string | null = null
    for (const rubric of body.matchAll(/<Rubric\b([^>]*)>([\s\S]*?)<\/Rubric>/g)) {
      if (!/\bkind="preferred"/.test(rubric[1] ?? "")) continue
      for (const label of (rubric[2] ?? "").matchAll(/<Label\b([^>]*)>([\s\S]*?)<\/Label>/g)) {
        const lang = /\bxml:lang="([^"]*)"/.exec(label[1] ?? "")?.[1]
        const value = decodeXml((label[2] ?? "").replace(/<[^>]+>/g, ""))
          .replace(/\s+/g, " ")
          .trim()
        if (!lang || lang.toLowerCase().startsWith(language)) {
          title = value
          break
        }
        title ??= value
      }
      if (title) break
    }
    rows.push({ code: decodeXml(code), title: title ?? "", uri: null })
  }
  if (rows.length === 0) throw new Error('El ClaML no trae categorías (<Class kind="category">)')
  return rows
}

/**
 * Las entradas de un .zip (APPNOTE de PKWARE), sin dependencias: Node no trae
 * un lector y la OMS publica sus tabulaciones así. Basta lo que esos archivos
 * usan: sin cifrar, guardado (0) o deflate (8) y menos de 4 GB (sin Zip64).
 */
export function readZipEntries(bytes: Uint8Array): Map<string, Buffer> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minEnd = Math.max(0, data.length - 22 - 0xffff)
  let end = -1
  for (let at = data.length - 22; at >= minEnd; at--)
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  if (end < 0) throw new Error("No es un .zip: falta el directorio central")
  const count = data.readUInt16LE(end + 10)
  let at = data.readUInt32LE(end + 16)
  const entries = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error("El .zip está dañado")
    const flags = data.readUInt16LE(at + 8)
    const method = data.readUInt16LE(at + 10)
    const compressedSize = data.readUInt32LE(at + 20)
    const size = data.readUInt32LE(at + 24)
    const nameLength = data.readUInt16LE(at + 28)
    const extraLength = data.readUInt16LE(at + 30)
    const commentLength = data.readUInt16LE(at + 32)
    const localAt = data.readUInt32LE(at + 42)
    const name = data.toString("utf8", at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith("/")) continue
    if (flags & 1) throw new Error(`${name} está cifrado`)
    if (data.readUInt32LE(localAt) !== 0x04034b50) throw new Error("El .zip está dañado")
    const start = localAt + 30 + data.readUInt16LE(localAt + 26) + data.readUInt16LE(localAt + 28)
    const raw = data.subarray(start, start + compressedSize)
    const content =
      method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!content) throw new Error(`${name} usa una compresión que no se lee (${method})`)
    if (content.length !== size) throw new Error(`${name} no tiene el tamaño que declara el .zip`)
    entries.set(name, content)
  }
  return entries
}

/**
 * El texto de la lista: el archivo tal cual o, si es un .zip, su único archivo
 * de datos (.txt, .tsv, .csv o .xml; la OMS suma un readme y una hoja de
 * cálculo, que no se leen). El SHA-256 se verifica antes, sobre el archivo
 * descargado.
 */
export function diagnosisFileText(bytes: Uint8Array): string {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  if (!isZip) return Buffer.from(bytes).toString("utf8")
  const data = [...readZipEntries(bytes)].filter(
    ([name]) => /\.(txt|tsv|csv|xml)$/i.test(name) && !/(^|\/)readme\.txt$/i.test(name),
  )
  if (data.length !== 1)
    throw new Error(
      `El .zip debe traer un solo archivo de datos y trae ${data.length}: ${data.map(([name]) => name).join(", ")}`,
    )
  return data[0]![1].toString("utf8")
}

/** Lee el archivo según su forma: ClaML si es XML, si no CSV o TSV. */
export function parseDiagnosisFile(text: string): DiagnosisSourceRow[] {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 200)
  return head.startsWith("<") ? parseClaml(text) : parseDiagnosisDelimited(text)
}

/**
 * Las filas listas para el catálogo: código normalizado y con la forma de su
 * lista, sin repetidos ni títulos vacíos, con lo que se calcula al cargar
 * (categoría con subcódigos, odontológico y texto de búsqueda).
 */
export function prepareDiagnosisRows(
  system: DiagnosisSystemKey,
  source: readonly DiagnosisSourceRow[],
): DiagnosisCatalogRow[] {
  const seen = new Map<string, DiagnosisSourceRow>()
  for (const row of source) {
    const code = normalizeDiagnosisCode(system, row.code)
    if (!isDiagnosisCodeFormat(system, code))
      throw new Error(`Código inválido para ${system}: ${row.code}`)
    const title = row.title.replace(/\s+/g, " ").trim()
    if (!title) throw new Error(`Descripción vacía para ${code}`)
    const previous = seen.get(code)
    if (previous && previous.title !== title)
      throw new Error(`El código ${code} aparece dos veces con descripciones distintas`)
    seen.set(code, { code, title, uri: row.uri })
  }
  // Una categoría es el comienzo de otro código: K02 de K02.1, DA08.1 de DA08.10.
  const prefixes = new Set<string>()
  for (const code of seen.keys())
    for (let end = 3; end < code.length; end++) prefixes.add(code.slice(0, end))
  return [...seen.values()].map((row) => ({
    ...row,
    isCategory: prefixes.has(row.code),
    searchText: diagnosisSearchText(row.code, row.title),
  }))
}
