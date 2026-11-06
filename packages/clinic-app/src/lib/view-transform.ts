/**
 * Cuentas del visor que no dependen de la pantalla: girar de a cuartos de
 * vuelta y voltear una imagen (solo para mirar), y acercar en un punto sin
 * perder la imagen de vista.
 */

export type Point = { x: number; y: number }

/** El valor de un deslizador de Base UI, que llega como número o como lista. */
export function sliderValue(value: number | readonly number[], fallback = 0): number {
  return Array.isArray(value) ? (value[0] ?? fallback) : (value as number)
}

/** Cuartos de vuelta en el sentido del reloj (0 a 3). */
export type QuarterTurns = 0 | 1 | 2 | 3

export interface Orientation {
  turns: QuarterTurns
  /** Espejo horizontal, después de girar. */
  flip: boolean
}

export const UPRIGHT: Orientation = { turns: 0, flip: false }

export function nextTurn(turns: QuarterTurns): QuarterTurns {
  return ((turns + 1) % 4) as QuarterTurns
}

/** Ancho y alto de la imagen ya girada. */
export function orientedSize(
  width: number,
  height: number,
  o: Orientation,
): { width: number; height: number } {
  return o.turns % 2 ? { width: height, height: width } : { width, height }
}

/** De un punto de la imagen al mismo punto en la imagen girada y volteada. */
export function toOriented(p: Point, width: number, height: number, o: Orientation): Point {
  let q: Point
  if (o.turns === 1) q = { x: height - p.y, y: p.x }
  else if (o.turns === 2) q = { x: width - p.x, y: height - p.y }
  else if (o.turns === 3) q = { x: p.y, y: width - p.x }
  else q = { ...p }
  return o.flip ? { x: orientedSize(width, height, o).width - q.x, y: q.y } : q
}

/** Lo inverso: de un punto de la imagen girada al de la imagen original. */
export function fromOriented(p: Point, width: number, height: number, o: Orientation): Point {
  const u = o.flip ? orientedSize(width, height, o).width - p.x : p.x
  const v = p.y
  if (o.turns === 1) return { x: v, y: height - u }
  if (o.turns === 2) return { x: width - u, y: height - v }
  if (o.turns === 3) return { x: width - v, y: u }
  return { x: u, y: v }
}

/** Prepara un lienzo para dibujar la imagen original girada y volteada. */
export function orientContext(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  o: Orientation,
): void {
  const size = orientedSize(width, height, o)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (o.flip) {
    ctx.translate(size.width, 0)
    ctx.scale(-1, 1)
  }
  if (o.turns === 1) {
    ctx.translate(height, 0)
    ctx.rotate(Math.PI / 2)
  } else if (o.turns === 2) {
    ctx.translate(width, height)
    ctx.rotate(Math.PI)
  } else if (o.turns === 3) {
    ctx.translate(0, width)
    ctx.rotate((3 * Math.PI) / 2)
  }
}

/** Acercamiento: escala y desplazamiento en px de la pantalla (origen arriba a la izquierda). */
export interface ZoomState {
  scale: number
  x: number
  y: number
}

export const FITTED: ZoomState = { scale: 1, x: 0, y: 0 }
export const MIN_SCALE = 1
export const MAX_SCALE = 8

/** Que la imagen ampliada siga cubriendo su marco: no se arrastra fuera de vista. */
export function clampZoom(z: ZoomState, frame: { width: number; height: number }): ZoomState {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, z.scale))
  if (scale === 1) return FITTED
  const minX = frame.width * (1 - scale)
  const minY = frame.height * (1 - scale)
  return {
    scale,
    x: Math.min(0, Math.max(minX, z.x)),
    y: Math.min(0, Math.max(minY, z.y)),
  }
}

/** Acerca (factor > 1) o aleja alrededor de un punto del marco, que queda en su lugar. */
export function zoomAt(
  z: ZoomState,
  factor: number,
  at: Point,
  frame: { width: number; height: number },
): ZoomState {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, z.scale * factor))
  const ratio = scale / z.scale
  return clampZoom({ scale, x: at.x - (at.x - z.x) * ratio, y: at.y - (at.y - z.y) * ratio }, frame)
}

/** Doble clic: de ajustada a 2× en ese punto, y de cualquier acercamiento a ajustada. */
export function toggleZoom(
  z: ZoomState,
  at: Point,
  frame: { width: number; height: number },
): ZoomState {
  return z.scale > 1 ? FITTED : zoomAt(z, 2, at, frame)
}
