import { type ArchRows, archLayout } from "@odentia/dental/odontogram-arch"
import { drawnWidthMm } from "@odentia/dental/tooth-front"
import { FRONT_PX_PER_MM, frontViewSize } from "./odontogram-front"

/**
 * Cómo se acomodan las dos vistas (24 nov 2026, tras verse mal en producción: cada vista crecía con
 * la pantalla, la de frente enorme y el arco chico). Cada una tiene su tamaño, el mismo en todas
 * las pantallas: la de frente a `FRONT_PX_PER_MM` y el arco con su muela al 80 % de la de frente.
 * Siempre las dos arcadas, nunca una a la vez (24 nov). El acomodo es el primero que cabe:
 * - «whole»: cada arco a la izquierda, a la altura de su fila;
 * - «top»: los dos arcos arriba, lado a lado (más chicos si no entran), y la boca de frente debajo;
 * - «narrow»: el celular, cada arcada seguida de la otra, con su arco a todo el ancho y su fila en
 *   dos de 8.
 * Si sobra espacio, sobra a los dos lados: nada se estira.
 */
export type MouthLayout = "whole" | "top" | "narrow"

/** Entre el arco y la vista de frente (gap-4): con más, a 1024 px de pantalla ya no cabían lado a lado. */
export const VIEWS_GAP = 16
/** Entre los dos arcos, uno sobre otro, en «whole»: ya los separa el margen de sus números. */
const ARCH_GAP = 0
/**
 * Solo con temporales (un niño chico), la vista de frente un poco más grande: sus incisivas son las
 * más angostas y así no bajan de 24 px para el dedo. Son 20 piezas: la fila sigue corta.
 */
const PRIMARY_PX_PER_MM = 4.4
/** En el celular, la vista de frente llena el ancho, hasta este tamaño (px por mm de dibujo). */
const NARROW_MAX_PX_PER_MM = 5.2

/**
 * Alto sobre ancho de cada arco: una herradura casi el doble de ancha que de alta (24 nov: más alta se veía
 * mal; más baja, el arco no cabía al lado de su fila desde 1024 px de pantalla); en la mixta, algo más
 * honda, porque lleva adentro la de las temporales.
 */
const ARCH_ASPECT = { plain: 0.56, mixed: 0.6 }
/**
 * En el celular el arco va a todo el ancho y más hondo: con la herradura baja del escritorio, a
 * unos 300 px sus piezas quedaban en 20 px (24 nov). Ahí se marcan las caras con el dedo.
 */
const NARROW_ARCH_ASPECT = { plain: 0.7, mixed: 0.85 }
/** La muela del arco mide esto de la de frente: las dos vistas en proporción. */
const ARCH_TO_FRONT = 1
/**
 * Con los arcos arriba, cuánto se pueden achicar como mucho (de su tamaño). Más, sus piezas bajaban
 * a 12–15 px (solo temporales en un celular grande, la mixta a 490 px) y va mejor una arcada tras
 * otra. En la atención más angosta (606 px para la boca) quedan al 77 %: arriba, sin las filas
 * grandes del celular; la misma pieza se toca de frente, con 24 px o más.
 */
const TOP_MIN = 0.75
/** La temporal más chica del arco, en la mixta (px). */
const MIN_INNER_PX = 16

export interface MouthPlan {
  layout: MouthLayout
  /** Ancho de cada arco (px). */
  archWidth: number
  archAspect: number
  /**
   * En «whole»: cuánto bajan los arcos o la vista de frente (lo más bajo se centra en el alto de lo
   * más alto) y el espacio entre los dos arcos.
   */
  archTop: number
  archGap: number
  frontTop: number
  /** Px por mm de dibujo de la vista de frente. */
  frontPxPerMm: number
}

type Rows = readonly (readonly number[])[]

/**
 * El ancho del arco con el que su pieza más ancha mide `ARCH_TO_FRONT` de la misma pieza de frente.
 * El arco escala casi en proporción a su ancho: dos vueltas bastan.
 */
/** El ancho del arco depende solo de la dentición: no se recalcula con cada cambio de ancho. */
const archWidths = new Map<string, number>()

function archWidthFor(
  arch: { outer: ArchRows; inner?: ArchRows },
  aspect: number,
  pxPerMm: number,
): number {
  const key = `${arch.outer.lower.join(",")}|${arch.inner?.lower.join(",") ?? ""}|${aspect}|${pxPerMm}`
  const known = archWidths.get(key)
  if (known !== undefined) return known
  const lower = { upper: [], lower: arch.outer.lower }
  const inner = arch.inner ? { upper: [], lower: arch.inner.lower } : undefined
  const widest = (width: number) => {
    const layout = archLayout(width, lower, inner, { single: "lower", aspect, byTooth: true })
    return layout.teeth.filter((t) => !t.inner).reduce((a, b) => (b.w > a.w ? b : a))
  }
  // En la mixta, además, ninguna temporal del arco baja de 16 px: así se le marcan las caras.
  const smallestInner = (width: number) => {
    const layout = archLayout(width, lower, inner, { single: "lower", aspect, byTooth: true })
    return Math.min(...layout.teeth.filter((t) => t.inner).map((t) => t.w))
  }
  let width = 300
  for (let i = 0; i < 3; i++) {
    const tooth = widest(width)
    const target = ARCH_TO_FRONT * drawnWidthMm(tooth.tooth) * pxPerMm
    width *= target / tooth.w
  }
  if (inner) for (let i = 0; i < 3; i++) width *= Math.max(1, MIN_INNER_PX / smallestInner(width))
  archWidths.set(key, width)
  return width
}

/** El acomodo que cabe en `available` px (0: aún sin medir, la boca entera). */
export function planMouth(
  available: number,
  rows: {
    whole: Rows
    /** Las filas de cada arcada en el celular. */
    narrow?: readonly Rows[]
  },
  arch: { outer: ArchRows; inner?: ArchRows },
): MouthPlan {
  const mixed = Boolean(arch.inner)
  const archAspect = mixed ? ARCH_ASPECT.mixed : ARCH_ASPECT.plain
  const primaryOnly = (arch.outer.lower[0] ?? 0) >= 50
  const pxPerMm = primaryOnly ? PRIMARY_PX_PER_MM : FRONT_PX_PER_MM
  const archWidth = archWidthFor(arch, archAspect, pxPerMm)
  const none = { archTop: 0, archGap: 0, frontTop: 0, frontPxPerMm: pxPerMm }
  const whole = frontViewSize(rows.whole, pxPerMm)
  if (available === 0 || available >= archWidth + VIEWS_GAP + whole.width) {
    // Los dos arcos uno sobre otro y la boca de frente al lado, centrada en el alto de los dos
    // arcos: arriba pegada a su título quedaba descolgada, con espacio de sobra abajo (24 nov).
    const column = 2 * archWidth * archAspect + ARCH_GAP
    const offset = (column - whole.height) / 2
    return {
      layout: "whole",
      archWidth,
      archAspect,
      ...none,
      archGap: ARCH_GAP,
      archTop: Math.max(0, -offset),
      frontTop: Math.max(0, offset),
    }
  }
  // Lado a lado los dos arcos; si no entran a su tamaño, un poco más chicos, hasta `TOP_MIN`.
  const topArch = Math.min(archWidth, (available - VIEWS_GAP) / 2)
  if (available >= whole.width && topArch >= TOP_MIN * archWidth)
    return { layout: "top", archWidth: topArch, archAspect, ...none }
  // En el celular, el arco y la vista de frente a todo el ancho, del mismo ancho: ahí se marcan
  // las caras y se elige la pieza con el dedo (24 nov: el arco sobresalía de sus filas).
  const widest = Math.max(
    1,
    ...(rows.narrow ?? [rows.whole]).map((set) => frontViewSize(set, 1).width),
  )
  return {
    layout: "narrow",
    archWidth: Math.min(available, 400),
    archAspect: mixed ? NARROW_ARCH_ASPECT.mixed : NARROW_ARCH_ASPECT.plain,
    ...none,
    frontPxPerMm: Math.min(NARROW_MAX_PX_PER_MM, Math.min(available, 400) / widest),
  }
}

/**
 * Las filas de una arcada de frente: las permanentes en una de 16 y las de leche en una de 10; en
 * el celular (`split`), las permanentes en dos de 8: así, a 360 px, ninguna pieza baja de 24 px.
 */
export function singleArchRows(
  permanent: readonly number[],
  primary: readonly number[] | null,
  upper: boolean,
  split: boolean,
): number[][] {
  const halves = (row: readonly number[]) =>
    split ? [row.slice(0, row.length / 2), row.slice(row.length / 2)] : [[...row]]
  const permanentRows = permanent.length > 0 ? halves(permanent) : []
  if (!primary || primary.length === 0) return permanentRows
  // Con permanentes, las de leche van enteras en su fila, del lado de las coronas (abajo en la
  // superior, arriba en la inferior): en el celular, 10 entran en el ancho de 8 permanentes y la
  // fila no queda a medias (24 nov). Solas (dentición temporal), se parten como las demás.
  if (permanentRows.length === 0) return halves(primary)
  return upper ? [...permanentRows, [...primary]] : [[...primary], ...permanentRows]
}
