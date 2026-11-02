/**
 * El dibujo de una firma como trazado: el mismo en el PDF y en la hoja del
 * odontograma. Los trazos vienen en coordenadas 0–1000 de un recuadro de 22 × 7;
 * aquí se recortan a lo que ocupan y se devuelven sin deformar, con curvas
 * entre los puntos para que no se vean quebrados.
 */
export type SignatureStrokes = number[][][]

export interface SignaturePath {
  /** Trazado SVG, con y hacia abajo desde la esquina superior izquierda. */
  d: string
  /** Lo que mide, en las unidades del trazado. */
  width: number
  height: number
}

/** Cuánto mide una unidad en cada eje: el recuadro donde se firma es más ancho que alto. */
const UNIT_X = 22 / 1000
const UNIT_Y = 7 / 1000

const round = (value: number) => Math.round(value * 1000) / 1000

/** Nulo si no hay nada que dibujar: un trazo necesita al menos dos puntos. */
export function signaturePath(strokes: SignatureStrokes | null | undefined): SignaturePath | null {
  const drawn = (strokes ?? []).filter((stroke) => stroke.length >= 2)
  if (drawn.length === 0) return null
  const points = drawn.flat()
  const xs = points.map((point) => (point[0] ?? 0) * UNIT_X)
  const ys = points.map((point) => (point[1] ?? 0) * UNIT_Y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const at = (point: number[] | undefined): [number, number] => [
    round((point?.[0] ?? 0) * UNIT_X - left),
    round((point?.[1] ?? 0) * UNIT_Y - top),
  ]
  const parts: string[] = []
  for (const stroke of drawn) {
    const [startX, startY] = at(stroke[0])
    parts.push(`M${startX} ${startY}`)
    // Cada punto es el control de una curva que termina a medio camino del siguiente.
    for (let index = 1; index < stroke.length - 1; index++) {
      const [x, y] = at(stroke[index])
      const [nextX, nextY] = at(stroke[index + 1])
      parts.push(`Q${x} ${y} ${round((x + nextX) / 2)} ${round((y + nextY) / 2)}`)
    }
    const [endX, endY] = at(stroke[stroke.length - 1])
    parts.push(`L${endX} ${endY}`)
  }
  return {
    d: parts.join(""),
    width: round(Math.max(...xs) - left),
    height: round(Math.max(...ys) - top),
  }
}
