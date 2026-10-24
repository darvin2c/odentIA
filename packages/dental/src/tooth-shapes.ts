/**
 * El dibujo de cada pieza del odontograma, sin pantalla: la silueta de la
 * corona y sus raíces, los surcos, la caja de las cinco caras y el trazo de los
 * símbolos que se dibujan siempre igual. Lo usan la app (`tooth-svg.tsx`, la
 * placa del periodontograma) y la web, para que el odontograma se vea igual en
 * las dos. Coordenadas del viewBox 0 0 24 28 de la pieza, antes de girarla.
 */
import { surfacesForTooth } from "./anatomy.js"
import type { ToothType } from "./types.js"

// Quien dibuja solo con este archivo (la web) también necesita saber qué silueta lleva cada pieza.
export { toothTypeOf } from "./anatomy.js"

export const CROWN_BOX = { x0: 5, x1: 19, y0: 2.5, y1: 13.5, cx0: 9.5, cx1: 14.5, cy0: 5.5, cy1: 10.5 }

/** Silueta de la pieza; también la usa la placa del periodontograma, que es esta misma corona. */
export function silhouetteFor(type: ToothType): {
  crown: string
  roots: string[]
} {
  switch (type) {
    case "incisor":
      return {
        crown:
          "M12 1.8 C9.8 1.8 6.2 6.4 5.8 10.2 Q5.4 13.5 12 13.5 Q18.6 13.5 18.2 10.2 C17.8 6.4 14.2 1.8 12 1.8 Z",
        roots: ["M9.5 13.5 H14.5 L13 25 Q12.7 26.5 12 26.5 Q11.3 26.5 11 25 Z"],
      }
    case "canine":
      return {
        crown:
          "M12 1.2 C10.6 2.8 5.6 5.7 5.6 9 Q5.6 13.6 12 13.6 Q18.4 13.6 18.4 9 C18.4 5.7 13.4 2.8 12 1.2 Z",
        roots: ["M10 13.5 H14 L13 26 Q12.7 27 12 27 Q11.3 27 11 26 Z"],
      }
    case "premolar":
      return {
        crown:
          "M8 2.6 Q12 1.2 16 2.6 Q19 4.2 18.4 8 Q19 12.8 15.5 13.6 Q12 14.4 8.5 13.6 Q5 12.8 5.6 8 Q5 4.2 8 2.6 Z",
        roots: ["M10 13.5 H14 L13.4 24.5 Q13.2 26 12 26 Q10.8 26 10.6 24.5 Z"],
      }
    case "molar":
      return {
        crown:
          "M7.4 2.4 Q9.5 1.6 12 2.8 Q14.5 1.6 16.6 2.4 Q20 3.8 18.7 7.8 Q20 12.2 16.8 13.4 Q14.5 14.6 12 13.6 Q9.5 14.6 7.2 13.4 Q4 12.2 5.3 7.8 Q4 3.8 7.4 2.4 Z",
        roots: [
          "M6.5 13.5 H10 L9.6 24 Q9.5 25.5 8.3 25.5 Q7.1 25.5 7 24 Z",
          "M14 13.5 H17.5 L17 24 Q16.9 25.5 15.7 25.5 Q14.5 25.5 14.4 24 Z",
        ],
      }
  }
}

/** Surcos sutiles solo para modos no interactivos (arco/preview): parecen piezas, no cubos. */
export function groovesFor(type: ToothType): string[] {
  switch (type) {
    case "incisor":
      return ["M7.2 11.4 Q12 12.8 16.8 11.4"]
    case "canine":
      return ["M12 3.2 Q10.8 7 12 10.4"]
    case "premolar":
      return ["M12 3.8 Q10.5 6.4 12 8 Q13.5 9.6 12 12", "M8 7.8 Q12 6 16 7.8"]
    case "molar":
      return [
        "M10.5 4 Q13 5.6 11.5 7.8 Q10 10 12.5 12",
        "M7.5 8 Q10.4 6.4 12 7.8 Q13.6 9.2 16.5 7.6",
      ]
  }
}

export interface ZoneDef {
  surface: string
  points: string
  dot: { cx: number; cy: number }
}

/**
 * Zonas de la corona en coordenadas previas a cualquier transformación.
 *
 * En cuadrícula (tile) la pieza superior se voltea en vertical, lo que conserva
 * izquierda/derecha. En el arco la pieza se GIRA siguiendo la herradura (cerca
 * de 180° arriba), y un giro también invierte izquierda/derecha: en las piezas
 * superiores mesial y distal se intercambian o se pintarían del lado opuesto.
 */
export function zonesFor(toothNumber: number, rotatedOnArch = false): ZoneDef[] {
  const quadrant = Math.trunc(toothNumber / 10)
  const upper = quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6
  const tileMesialOnRight = quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8
  const mesialOnRight = rotatedOnArch && upper ? !tileMesialOnRight : tileMesialOnRight
  // Claves en inglés del catálogo; la cara externa/interna/central sale de surfacesForTooth.
  const catalog = surfacesForTooth(toothNumber)
  const innerSurface = catalog.includes("palatal") ? "palatal" : "lingual"
  const outerSurface = catalog.includes("facial") ? "facial" : "buccal"
  const centralSurface = catalog.includes("incisal") ? "incisal" : "occlusal"
  const { x0, x1, y0, y1, cx0, cx1, cy0, cy1 } = CROWN_BOX
  return [
    {
      surface: mesialOnRight ? "distal" : "mesial",
      points: `${x0},${y0} ${cx0},${cy0} ${cx0},${cy1} ${x0},${y1}`,
      dot: { cx: 7.9, cy: 8 },
    },
    {
      surface: mesialOnRight ? "mesial" : "distal",
      points: `${x1},${y0} ${cx1},${cy0} ${cx1},${cy1} ${x1},${y1}`,
      dot: { cx: 16.1, cy: 8 },
    },
    {
      surface: innerSurface,
      points: `${x0},${y0} ${x1},${y0} ${cx1},${cy0} ${cx0},${cy0}`,
      dot: { cx: 12, cy: 4.3 },
    },
    {
      surface: outerSurface,
      points: `${x0},${y1} ${cx0},${cy1} ${cx1},${cy1} ${x1},${y1}`,
      dot: { cx: 12, cy: 11.7 },
    },
    {
      surface: centralSurface,
      points: `${cx0},${cy0} ${cx1},${cy0} ${cx1},${cy1} ${cx0},${cy1}`,
      dot: { cx: 12, cy: 8 },
    },
  ]
}

/** Aspa de la pieza ausente: dos líneas sobre el gráfico de la pieza. */
export const MISSING_TOOTH_LINES = [
  { x1: 6, y1: 3, x2: 18, y2: 13 },
  { x1: 18, y1: 3, x2: 6, y2: 13 },
] as const

/** Cuadrado de la corona sobre la corona clínica. */
export const CROWN_SQUARE = { x: 8, y: 3.2, width: 8, height: 8.6 } as const
