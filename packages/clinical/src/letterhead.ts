/**
 * La hoja membretada de la clínica (ADR 0180): la cuenta que comparten el servidor (que
 * la guarda y la dibuja en los papeles) y la pantalla (que dibuja el recuadro y recorta
 * sus franjas). Una sola, para que lo que se ve al subirla sea lo que sale en el papel.
 */

/** Puntos (1/72 de pulgada) por milímetro. */
export const PT_PER_MM = 72 / 25.4
/** Lo mínimo que se deja desde cada borde: las impresoras no imprimen en el borde. */
const MIN_MARGIN_MM = 5
/** El texto siempre tiene lugar: al menos la mitad del ancho y el 40 % del alto de la hoja. */
const MIN_TEXT_WIDTH = 0.5
const MIN_TEXT_HEIGHT = 0.4

const A4 = { width: 595.28, height: 841.89 }
const LETTER = { width: 612, height: 792 }

/** Dónde va el texto: lo que se deja desde cada borde de la hoja, en milímetros. */
export interface LetterheadMargins {
  topMm: number
  bottomMm: number
  leftMm: number
  rightMm: number
}

/** Medio milímetro basta. */
export function halfMm(value: number): number {
  return Math.round(value * 2) / 2
}

/**
 * Dónde va el texto, dentro de lo posible: al menos 5 mm desde cada borde y, si los
 * márgenes no dejan lugar, se achican en proporción hasta dejar la mitad del ancho y el
 * 40 % del alto.
 */
export function clampLetterheadMargins(
  page: { widthPt: number; heightPt: number },
  margins: LetterheadMargins,
): LetterheadMargins {
  const floor = (value: number) =>
    Number.isFinite(value) ? Math.max(MIN_MARGIN_MM, value) : MIN_MARGIN_MM
  const fit = (a: number, b: number, room: number): [number, number] =>
    a + b <= room ? [a, b] : [(a * room) / (a + b), (b * room) / (a + b)]
  const [leftMm, rightMm] = fit(
    floor(margins.leftMm),
    floor(margins.rightMm),
    (page.widthPt / PT_PER_MM) * (1 - MIN_TEXT_WIDTH),
  )
  const [topMm, bottomMm] = fit(
    floor(margins.topMm),
    floor(margins.bottomMm),
    (page.heightPt / PT_PER_MM) * (1 - MIN_TEXT_HEIGHT),
  )
  return {
    topMm: halfMm(topMm),
    bottomMm: halfMm(bottomMm),
    leftMm: halfMm(leftMm),
    rightMm: halfMm(rightMm),
  }
}

/** La página de una imagen subida como hoja: A4 o Carta si tiene su forma, si no del ancho de una A4. */
export function letterheadImagePage(
  widthPx: number,
  heightPx: number,
): { width: number; height: number } {
  const ratio = heightPx / widthPx
  if (Math.abs(ratio - A4.height / A4.width) < 0.02) return A4
  if (Math.abs(ratio - LETTER.height / LETTER.width) < 0.02) return LETTER
  return { width: A4.width, height: A4.width * ratio }
}
