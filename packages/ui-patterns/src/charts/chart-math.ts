/**
 * Cuentas de los gráficos de datos, sin React: marcas del eje, paso de la
 * escala de color y movimiento con el teclado. Se prueban solas.
 */

/** Marcas «redondas» del eje de 0 hasta cubrir `max`: 0, 20 mil, 40 mil, 60 mil. */
export function niceTicks(max: number, count = 3): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1]
  const raw = max / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power
  const ticks: number[] = []
  for (let value = 0; value < max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)))
  if ((ticks[ticks.length - 1] ?? 0) < max) ticks.push(Number((ticks.length * step).toPrecision(12)))
  return ticks
}

/** Paso de la escala de cuatro (0 es el vacío): cuánto de `max` alcanza `value`. */
export function scaleLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!(value > 0) || !(max > 0)) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4
}

/**
 * Casilla siguiente con las flechas en una cuadrícula de `rows` × `columns`:
 * izquierda y derecha recorren la fila, arriba y abajo la columna, Inicio y
 * Fin van a los extremos de la fila. Una tecla que no mueve devuelve `null`.
 */
export function moveInGrid(
  at: { row: number; column: number },
  key: string,
  rows: number,
  columns: number,
): { row: number; column: number } | null {
  const clamp = (value: number, size: number): number => Math.max(0, Math.min(size - 1, value))
  if (key === "ArrowRight") return { row: at.row, column: clamp(at.column + 1, columns) }
  if (key === "ArrowLeft") return { row: at.row, column: clamp(at.column - 1, columns) }
  if (key === "ArrowDown") return { row: clamp(at.row + 1, rows), column: at.column }
  if (key === "ArrowUp") return { row: clamp(at.row - 1, rows), column: at.column }
  if (key === "Home") return { row: at.row, column: 0 }
  if (key === "End") return { row: at.row, column: columns - 1 }
  return null
}

/** Puntos de una línea pequeña en un lienzo de `width` × `height`, con margen para el punto final. */
export function sparkPoints(values: Array<number | null>, width: number, height: number, pad = 4): Array<{ x: number; y: number } | null> {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (known.length === 0) return values.map(() => null)
  const min = Math.min(...known)
  const max = Math.max(...known)
  const span = max - min || 1
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  return values.map((value, index) =>
    value === null || !Number.isFinite(value)
      ? null
      : {
          x: Number((pad + index * step).toFixed(2)),
          // Sin variación, la línea va al medio: plana no significa «en cero».
          y: Number((max === min ? height / 2 : pad + (1 - (value - min) / span) * (height - pad * 2)).toFixed(2)),
        },
  )
}
