// Las vistas de la demo de imágenes: una tomografía real de ejemplo (PreDentalSurgery, de los datos de
// prueba de 3D Slicer, de uso libre), remuestreada con el mismo cálculo del visor de la clínica
// (`packages/clinic-app/src/lib/cbct-arch.ts` y `cbct-volume.ts`: arco propuesto, panorámica de 12 mm,
// transversales y los tres cortes con el brillo «Hueso» del estudio). Las radiografías son la suma de
// la misma tomografía de lado y de frente. Las imágenes viven en `public/img/imaging/`.

/** Ancho de la panorámica en columnas (una por cada 0,5 mm del arco). */
export const PANO_COLUMNS = 192

/**
 * Las piezas de abajo, de la 46 a la 36: dónde caen en la panorámica (columna) y el ancho del hueso
 * medido en su corte transversal a 62 % del alto (de lengua a mejilla, en mm del volumen).
 */
export const CROSSES = [
  { fdi: 46, column: 26, mm: 8.5, x0: 24, x1: 40 },
  { fdi: 45, column: 42, mm: 10, x0: 19, x1: 38 },
  { fdi: 44, column: 54, mm: 11, x0: 15, x1: 36 },
  { fdi: 43, column: 65, mm: 12, x0: 12, x1: 35 },
  { fdi: 42, column: 76, mm: 12, x0: 10, x1: 33 },
  { fdi: 41, column: 85, mm: 13, x0: 9, x1: 34 },
  { fdi: 31, column: 95, mm: 14, x0: 9, x1: 36 },
  { fdi: 32, column: 106, mm: 12.5, x0: 11, x1: 35 },
  { fdi: 33, column: 118, mm: 11, x0: 15, x1: 36 },
  { fdi: 34, column: 131, mm: 11, x0: 18, x1: 39 },
  { fdi: 35, column: 144, mm: 10, x0: 22, x1: 41 },
  { fdi: 36, column: 161, mm: 9, x0: 26, x1: 43 },
] as const

/** Tamaño del corte transversal en vóxeles y la fila donde se midió. */
export const CROSS_SIZE = { width: 65, height: 89, row: 55 }

/** Cuadros de cada plano en su tira (`axial.jpg`, `coronal.jpg`, `sagittal.jpg`), de 300 × 300. */
export const FRAMES = 24

export const IMG = "/img/imaging"
