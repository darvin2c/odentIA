/**
 * Lo que se pega en la cuadrícula desde Excel o Google Sheets (texto con tabulaciones). Si la tabla
 * trae su fila o su columna de títulos (las tallas, los colores), se reconocen y cada número va a
 * su talla y su color por el nombre, no por la posición; los títulos nunca entran como valores. Sin
 * títulos, se pega desde la celda elegida. Lo que no entra se dice, uno por uno.
 */

export interface PasteAxisItem {
  id: string
  label: string
}

export interface PasteCell {
  row: string
  column: string
  value: string | null
}

export interface PasteResult {
  cells: PasteCell[]
  /** Lo que no entró, en palabras: «talla «43» (no está en la ficha)». */
  missed: string[]
}

const norm = (text: string) => text.trim().toLocaleLowerCase("es")

/** El índice de cada valor en los nombres del eje, o -1 si no está; null si está vacío. */
function indexes(values: string[], items: PasteAxisItem[]): (number | null)[] {
  return values.map((v) => (norm(v) ? items.findIndex((i) => norm(i.label) === norm(v)) : null))
}

/**
 * Si esos valores son los títulos de un eje: todos los que no están vacíos son nombres del eje (al
 * menos dos, o el único que tiene), o la esquina dice qué son («Talla») y al menos uno coincide.
 * Unos números de stock que por casualidad son tallas no bastan: tienen que serlo todos.
 */
function isHeader(found: (number | null)[], items: PasteAxisItem[], cornerIsText: boolean) {
  const filled = found.filter((i) => i !== null)
  if (!filled.length) return false
  const matched = filled.filter((i) => i >= 0).length
  if (cornerIsText) return matched > 0
  return matched === filled.length && (matched >= 2 || items.length === 1)
}

export function readPaste(
  table: string[][],
  rows: PasteAxisItem[],
  columns: PasteAxisItem[],
  at: { r: number; c: number },
  parse: (text: string) => string | null | undefined,
  names: { row: string; column: string },
): PasteResult {
  const first = table[0] ?? []
  const corner = first[0] ?? ""
  const cornerIsText = norm(corner) !== "" && parse(corner) === undefined
  const top = first.slice(1)
  const left = table.slice(1).map((line) => line[0] ?? "")

  // ¿La primera fila y la primera columna son títulos? De qué eje, en el orden de la cuadrícula o
  // al revés (las tallas de lado).
  type Layout = { topIs: "columns" | "rows" | null; leftIs: "columns" | "rows" | null }
  const layouts: Layout[] = [
    { topIs: "columns", leftIs: "rows" },
    { topIs: "rows", leftIs: "columns" },
    { topIs: "columns", leftIs: null },
    { topIs: "rows", leftIs: null },
    { topIs: null, leftIs: "rows" },
    { topIs: null, leftIs: "columns" },
  ]
  const axis = (which: "columns" | "rows") => (which === "columns" ? columns : rows)
  const fits = (l: Layout) => {
    // Con las dos, la esquina es de las dos; con una sola, la fila o columna entera es título.
    const both = l.topIs !== null && l.leftIs !== null
    const topValues = both ? top : first
    const leftValues = both ? left : table.map((line) => line[0] ?? "")
    if (
      l.topIs &&
      !isHeader(indexes(topValues, axis(l.topIs)), axis(l.topIs), both && cornerIsText)
    )
      return false
    if (
      l.leftIs &&
      !isHeader(indexes(leftValues, axis(l.leftIs)), axis(l.leftIs), both && cornerIsText)
    )
      return false
    return true
  }
  const layout = layouts.find(fits) ?? { topIs: null, leftIs: null }

  const cells: PasteCell[] = []
  const missed: string[] = []
  let outside = 0
  const startRow = layout.topIs ? 1 : 0
  const startCol = layout.leftIs ? 1 : 0
  const topIndex = layout.topIs ? indexes(first.slice(startCol), axis(layout.topIs)) : []
  const leftIndex = layout.leftIs
    ? indexes(
        table.slice(startRow).map((line) => line[0] ?? ""),
        axis(layout.leftIs),
      )
    : []
  const axisName = (which: "columns" | "rows") => (which === "columns" ? names.column : names.row)

  // Los títulos que no están en la ficha se dicen una vez.
  topIndex.forEach((i, k) => {
    if (i === -1 && layout.topIs)
      missed.push(
        `${axisName(layout.topIs)} «${first[startCol + k]!.trim()}» (no está en la ficha)`,
      )
  })
  leftIndex.forEach((i, k) => {
    if (i === -1 && layout.leftIs)
      missed.push(
        `${axisName(layout.leftIs)} «${table[startRow + k]![0]!.trim()}» (no está en la ficha)`,
      )
  })

  table.slice(startRow).forEach((line, dr) => {
    line.slice(startCol).forEach((raw, dc) => {
      // Dónde va: por el título si lo hay, si no por la posición desde la celda elegida.
      let r = at.r + dr
      let c = at.c + dc
      const byTop = layout.topIs ? topIndex[dc] : undefined
      const byLeft = layout.leftIs ? leftIndex[dr] : undefined
      // Bajo un título que no está en la ficha (ya dicho) o vacío, no se pega.
      if (byTop === -1 || byLeft === -1 || byTop === null || byLeft === null) return
      if (layout.topIs === "columns" && byTop !== undefined && byTop !== null) c = byTop
      if (layout.topIs === "rows" && byTop !== undefined && byTop !== null) r = byTop
      if (layout.leftIs === "rows" && byLeft !== undefined && byLeft !== null) r = byLeft
      if (layout.leftIs === "columns" && byLeft !== undefined && byLeft !== null) c = byLeft
      // Con un solo título y al revés que la cuadrícula, cada línea es la siguiente del otro eje.
      if (layout.topIs === "rows" && !layout.leftIs) c = at.c + dr
      if (layout.leftIs === "columns" && !layout.topIs) r = at.r + dc
      if (r >= rows.length || c >= columns.length || r < 0 || c < 0) {
        if (raw.trim()) outside++
        return
      }
      const value = parse(raw)
      if (value === undefined) {
        const name = [rows[r]?.label, columns[c]?.label].filter(Boolean).join(" ")
        missed.push(`«${raw.trim()}» en ${name} (no vale aquí)`)
        return
      }
      cells.push({ row: rows[r]!.id, column: columns[c]!.id, value })
    })
  })
  if (outside)
    missed.push(outside === 1 ? "1 valor que no cabe" : `${outside} valores que no caben`)
  return { cells, missed }
}
