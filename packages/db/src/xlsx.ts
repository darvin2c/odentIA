import { inflateRawSync } from "node:zlib"

/**
 * Leer un .zip y las hojas de un .xlsx sin dependencias: lo usan la carga de
 * listas oficiales (la CIE-10 del MINSA, ADR 0103) y la preparación de la
 * carga de una clínica (sus Excel, ADR 0104). Solo lee: nunca calcula
 * fórmulas, ejecuta macros ni sigue vínculos externos.
 */

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&")
}

/** ¿Empieza como un .zip (también un .xlsx)? */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
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

/** Índice de la columna de una celda («A1» → 0, «AB7» → 27). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A"
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

/** El texto de un `<si>` o un `<is>`: sus `<t>`, también los de cada tramo con formato. */
function xmlRunsText(xml: string): string {
  return decodeXml([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? "").join(""))
}

/** Las hojas de un .xlsx, en su orden, con su nombre y su relación. */
function xlsxSheets(entries: ReadonlyMap<string, Buffer>): Array<{ name: string; rid: string }> {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8")
  if (!workbook) throw new Error("El .xlsx no trae xl/workbook.xml")
  return [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decodeXml(/\bname="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? ""),
    rid: /\br:id="([^"]+)"/.exec(m[1] ?? "")?.[1] ?? "",
  }))
}

/** Los nombres de las hojas de un .xlsx, en su orden. */
export function xlsxSheetNames(entries: ReadonlyMap<string, Buffer>): string[] {
  return xlsxSheets(entries).map((sheet) => sheet.name)
}

/**
 * Las filas de una hoja de un .xlsx (ECMA-376, SpreadsheetML), con las
 * entradas de su .zip: textos compartidos, textos en la celda y números, cada
 * uno en su columna. Sin `sheetName`, la primera hoja. Una fecha llega como el
 * número de días con que la guarda Excel; una fórmula, con su último valor.
 */
export function readXlsxRows(entries: ReadonlyMap<string, Buffer>, sheetName?: string): string[][] {
  const sheets = xlsxSheets(entries)
  const chosen = sheetName === undefined ? sheets[0] : sheets.find((sheet) => sheet.name === sheetName)
  if (sheetName !== undefined && !chosen)
    throw new Error(`El .xlsx no tiene la hoja «${sheetName}»; tiene ${sheets.map((sheet) => `«${sheet.name}»`).join(", ")}`)
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? ""
  const target = chosen?.rid
    ? new RegExp(`<Relationship\\b[^>]*\\bId="${chosen.rid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ??
      new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${chosen.rid}"`).exec(rels)?.[1]
    : undefined
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml"
  const sheet = entries.get(sheetPath)?.toString("utf8")
  if (!sheet) throw new Error(`El .xlsx no trae su hoja (${sheetPath})`)
  const shared = [
    ...(entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => xmlRunsText(m[1] ?? ""))
  const rows: string[][] = []
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? ""
      const body = cell[2] ?? ""
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      const text =
        type === "s"
          ? (shared[Number(value)] ?? "")
          : type === "inlineStr"
            ? xmlRunsText(body)
            : decodeXml(value ?? "")
      cells[columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? String.fromCharCode(65 + cells.length))] =
        text
    }
    rows.push(Array.from(cells, (cell) => cell ?? ""))
  }
  return rows
}
