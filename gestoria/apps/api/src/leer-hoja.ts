import { unzipSync } from "fflate"

/**
 * Leer la hoja que la tienda ya tiene (decisión 4 del lienzo «La ficha del producto»): el CSV de
 * hoy y también el Excel (.xlsx, Office Open XML, ISO/IEC 29500), con las tallas en filas (una
 * fila por talla, como la hoja de ejemplo) o en columnas (una columna por talla con su stock).
 * Todo termina en las mismas filas que la hoja de ejemplo (`hoja.ts`): así se revisa y se guarda
 * con una sola regla.
 *
 * El Excel se lee sin biblioteca de hojas: se abre el zip (fflate) y se leen solo la primera hoja
 * y sus textos. Sin fórmulas ni macros: se toma el valor guardado. Con topes de tamaño, para que
 * un archivo armado a propósito no llene la memoria.
 */

/** Lo más que se abre de un Excel: sus archivos sin comprimir. */
const MAX_XLSX_UNZIPPED = 20_000_000

export class SheetReadError extends Error {}

const isZip = (bytes: Uint8Array) =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

/** Las filas de la hoja como textos, sea CSV o Excel. El CSV vuelve como texto para leerlo como hoy. */
export function sheetSource(bytes: Uint8Array): { text: string } | { rows: string[][] } {
  if (isZip(bytes)) return { rows: readXlsx(bytes) }
  return { text: new TextDecoder("utf-8").decode(bytes) }
}

const decodeXml = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, code: string) => {
    if (code === "amp") return "&"
    if (code === "lt") return "<"
    if (code === "gt") return ">"
    if (code === "quot") return '"'
    if (code === "apos") return "'"
    const n = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""
  })

/** El texto de un `<si>` o un `<is>`: todos sus `<t>` juntos (también los de formato, `<r>`). */
const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join("")

const columnIndex = (ref: string) => {
  let n = 0
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function readXlsx(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>
  let total = 0
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize
        if (total > MAX_XLSX_UNZIPPED) throw new SheetReadError("muy grande")
        return (
          file.name === "xl/workbook.xml" ||
          file.name === "xl/_rels/workbook.xml.rels" ||
          file.name === "xl/sharedStrings.xml" ||
          /^xl\/worksheets\/[^/]+\.xml$/.test(file.name)
        )
      },
    })
  } catch (error) {
    if (error instanceof SheetReadError)
      throw new SheetReadError("La hoja es muy grande: divídela en partes")
    throw new SheetReadError(
      "No pudimos abrir el Excel. Guárdalo otra vez como .xlsx o como CSV UTF-8.",
    )
  }
  const text = (name: string) => (files[name] ? new TextDecoder().decode(files[name]) : null)
  // La primera hoja del libro, por su relación (no siempre se llama sheet1).
  const workbook = text("xl/workbook.xml") ?? ""
  const rels = text("xl/_rels/workbook.xml.rels") ?? ""
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  const target = firstId
    ? (new RegExp(`<Relationship\\b[^>]*\\bId="${firstId}"[^>]*\\bTarget="([^"]+)"`).exec(
        rels,
      )?.[1] ??
      new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstId}"`).exec(rels)?.[1])
    : undefined
  const sheetName = target
    ? `xl/${target.replace(/^\/?xl\//, "").replace(/^\.\//, "")}`
    : "xl/worksheets/sheet1.xml"
  const sheet = text(sheetName) ?? text("xl/worksheets/sheet1.xml")
  if (!sheet) throw new SheetReadError("El Excel no tiene ninguna hoja con datos.")
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => textOf(m[1]!),
  )
  const rows: string[][] = []
  for (const row of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const at = Number(/\br="(\d+)"/.exec(row[1]!)?.[1] ?? rows.length + 1) - 1
    if (at > 100_000) break
    const cells: string[] = []
    for (const cell of row[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!
      const body = cell[2] ?? ""
      const ref = /\br="([A-Z]{1,3}\d+)"/.exec(attrs)?.[1]
      const col = ref ? columnIndex(ref) : cells.length
      if (col > 200) continue
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let out = ""
      if (type === "s") out = shared[Number(value)] ?? ""
      else if (type === "inlineStr") out = textOf(body)
      else if (type === "b") out = value === "1" ? "Sí" : "No"
      else if (value !== undefined) out = decodeXml(value)
      while (cells.length < col) cells.push("")
      cells[col] = out
    }
    while (rows.length < at) rows.push([])
    rows[at] = cells
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()

/** Una cabecera que es una talla: «38», «38.5», «Talla 38», «S», «XL», «Única». */
const SIZE_HEADER = /^(talla\s+)?(\d{1,2}([.,]5)?|xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|unica)$/

/**
 * Pasa la hoja de la tienda a las columnas de la hoja de ejemplo: «Talla» y «Color» sueltas pasan a
 * «Opción 1/Valor 1»; con una columna por talla (y sin «Stock»), cada talla con stock es una fila.
 * Si ya viene como la de ejemplo, no se toca.
 */
export function toExampleColumns(
  rows: string[][],
  canonical: readonly string[],
): { rows: string[][]; sourceRows: number[] } {
  const same = { rows, sourceRows: rows.map((_, i) => i + 1) }
  if (rows.length === 0) return same
  const header = rows[0]!.map(fold)
  const known = new Set(canonical.map(fold))
  const has = (title: string) => header.includes(fold(title))
  const optionColumns = ["Color", "Talla"].filter((title) => has(title) && !known.has(fold(title)))
  const sizeColumns = has("Stock")
    ? []
    : header.flatMap((h, i) => (SIZE_HEADER.test(h) && !known.has(h) ? [i] : []))
  const usesOptions = has("Opción 1") || has("Valor 1")
  if ((optionColumns.length === 0 || usesOptions) && sizeColumns.length === 0) return same

  const at = (title: string) => header.indexOf(fold(title))
  const out: string[][] = [[...canonical]]
  const sourceRows = [1]
  const put = (target: string[], title: string, value: string) => {
    const i = canonical.findIndex((c) => fold(c) === fold(title))
    if (i >= 0) target[i] = value
  }
  const sizeName = (i: number) => {
    const raw = rows[0]![i]!.trim().replace(/^talla\s+/i, "")
    return /^\d/.test(raw) ? raw.replace(",", ".") : raw.toUpperCase().replace(/^UNICA$/, "Única")
  }
  for (const [n, row] of rows.slice(1).entries()) {
    const base = canonical.map(() => "")
    // Lo que ya está con su nombre de la hoja de ejemplo.
    canonical.forEach((title, i) => {
      const from = at(title)
      if (from >= 0) base[i] = row[from] ?? ""
    })
    const options: [string, string][] = []
    if (!usesOptions)
      for (const title of optionColumns) {
        const value = (row[at(title)] ?? "").trim()
        if (value) options.push([title, value])
      }
    const emit = (extra: [string, string] | null, stock: string | null) => {
      const line = [...base]
      const all = extra ? [...options.filter(([t]) => t !== extra[0]), extra] : options
      all.slice(0, 3).forEach(([title, value], n) => {
        put(line, `Opción ${n + 1}`, title)
        put(line, `Valor ${n + 1}`, value)
      })
      if (stock !== null) put(line, "Stock", stock)
      out.push(line)
      sourceRows.push(n + 2)
    }
    if (sizeColumns.length === 0) {
      emit(null, null)
      continue
    }
    // Una fila por talla que tiene algo escrito; una talla en blanco no se vende.
    let any = false
    for (const i of sizeColumns) {
      const stock = (row[i] ?? "").trim()
      if (stock === "") continue
      any = true
      emit(["Talla", sizeName(i)], stock)
    }
    if (!any) emit(null, "0")
  }
  return { rows: out, sourceRows }
}
