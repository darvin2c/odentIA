/**
 * «Pegar tu lista» (tablero 4): lo que se copia de Excel o Google Sheets llega
 * como texto con las columnas separadas por tabulador. Aquí se parte en filas
 * y se reconoce qué es cada columna (Nombre, Unidad, Hay y Mínimo); lo demás
 * (si es nuevo, si se parece a otro, si «Hay» no es un número) lo decide el
 * servidor con `previewProductImport`.
 */
import { parseWhole, type ImportRowInput } from "./inventory"

export type PasteColumn = "nombre" | "unidad" | "hay" | "minimo" | "ignorar"

export const PASTE_COLUMN_OPTIONS: ReadonlyArray<{ value: PasteColumn; label: string }> = [
  { value: "nombre", label: "Nombre" },
  { value: "unidad", label: "Unidad" },
  { value: "hay", label: "Hay" },
  { value: "minimo", label: "Mínimo" },
  { value: "ignorar", label: "No usar" },
]

/** Se pegan hasta 500 filas por vez (lo mismo que acepta el servidor). */
export const PASTE_MAX_ROWS = 500

/** Una celda tal como la deja la hoja: sin comillas de Excel ni espacios de más. */
function cleanCell(cell: string): string {
  const text = cell.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"').trim()
  return text
}

/** Filas y celdas de lo pegado; las filas vacías no cuentan. */
export function splitSheet(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\t").map(cleanCell))
    .filter((cells) => cells.some((cell) => cell !== ""))
}

const HEADER: Array<[PasteColumn, RegExp]> = [
  // «Stock mínimo» o «Cantidad mínima» son el mínimo, no lo que hay: va primero.
  ["minimo", /(^|\s)m[ií]n(im[oa]|\.)?(\s|$)/i],
  ["nombre", /^(nombre|producto|art[ií]culo|descripci[oó]n|insumo|material|[ií]tem)\b/i],
  ["unidad", /^(unidad|unid\.?|presentaci[oó]n|medida|u\.?\s?m\.?)\b/i],
  ["hay", /^(hay|stock|existencias?|cantidad|cant\.?|saldo|inventario|tengo)\b/i],
]

function headerOf(cell: string): PasteColumn | null {
  for (const [column, pattern] of HEADER) if (pattern.test(cell.trim())) return column
  return null
}

function isNumber(cell: string): boolean {
  const parsed = parseWhole(cell)
  return parsed !== null && !Number.isNaN(parsed)
}

/**
 * Qué es cada columna. Si la primera fila son títulos («Nombre», «Stock»…),
 * mandan ellos. Si no, la primera columna con texto es el nombre, la segunda
 * con texto la unidad, la primera con números lo que hay y la segunda el mínimo.
 */
export function guessColumns(rows: string[][]): { header: boolean; columns: PasteColumn[] } {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const first = rows[0] ?? []
  const titles = first.map(headerOf)
  if (titles.some((title) => title !== null) && !first.some(isNumber)) {
    const seen = new Set<PasteColumn>()
    const columns = Array.from({ length: width }, (_, index) => {
      const title = titles[index] ?? null
      if (!title || seen.has(title)) return "ignorar" as const
      seen.add(title)
      return title
    })
    return { header: true, columns }
  }
  const body = rows.slice(0, 50)
  const numeric = Array.from({ length: width }, (_, index) => {
    const filled = body.map((row) => row[index] ?? "").filter((cell) => cell !== "" && cell !== "-" && cell !== "—")
    if (filled.length === 0) return null
    return filled.filter(isNumber).length / filled.length >= 0.5
  })
  const columns: PasteColumn[] = Array.from({ length: width }, () => "ignorar")
  const texts = numeric.flatMap((value, index) => (value === false ? [index] : []))
  const numbers = numeric.flatMap((value, index) => (value === true ? [index] : []))
  if (texts[0] !== undefined) columns[texts[0]] = "nombre"
  if (texts[1] !== undefined) columns[texts[1]] = "unidad"
  if (numbers[0] !== undefined) columns[numbers[0]] = "hay"
  if (numbers[1] !== undefined) columns[numbers[1]] = "minimo"
  return { header: false, columns }
}

/** Las filas para el servidor, con lo que dice cada columna elegida. */
export function sheetRows(rows: string[][], header: boolean, columns: PasteColumn[]): ImportRowInput[] {
  const at = (row: string[], column: PasteColumn) => {
    const index = columns.indexOf(column)
    const value = index >= 0 ? (row[index] ?? "").trim() : ""
    return value === "" ? null : value
  }
  return (header ? rows.slice(1) : rows).slice(0, PASTE_MAX_ROWS).map((row) => ({
    name: at(row, "nombre"),
    unit: at(row, "unidad"),
    onHand: at(row, "hay"),
    minQuantity: at(row, "minimo"),
  }))
}

/** «Nombre, Unidad, Hay y Mínimo»: las columnas que se reconocieron. */
export function recognizedText(columns: PasteColumn[]): string {
  const names = PASTE_COLUMN_OPTIONS.filter((option) => option.value !== "ignorar" && columns.includes(option.value)).map((option) => option.label)
  if (names.length === 0) return "ninguna"
  if (names.length === 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}
