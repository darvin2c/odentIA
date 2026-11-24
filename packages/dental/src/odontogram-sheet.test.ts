import { describe, expect, it } from "vitest"
import { isUpperTooth } from "./anatomy.js"
import {
  odontogramSheetRow,
  odontogramSheetScene,
  SHEET_INK,
  type SheetEntry,
  type SheetShape,
} from "./odontogram-sheet.js"

/**
 * La hoja de la norma la dibujan la pantalla y el PDF con estas mismas primitivas.
 * Las cifras esperadas son las del dibujo de antes (`odontogram-document.tsx`):
 * una pieza mide 60, la corona 46 × 44 y la raíz 26.
 */

let next = 0
function entry(
  toothNumber: number,
  condition: string,
  extra: Partial<SheetEntry> = {},
): SheetEntry {
  next += 1
  return { id: `e${next}`, toothNumber, condition, ...extra }
}

function rowOf(entries: SheetEntry[], caption: string) {
  const row = odontogramSheetScene(entries).rows.find((item) => item.caption === caption)
  if (!row) throw new Error(`Sin la fila ${caption}`)
  return row
}

const UPPER = "Dentición permanente superior"
const LOWER = "Dentición permanente inferior"

function painted(shapes: SheetShape[], ink: string): SheetShape[] {
  return shapes.filter((shape) =>
    shape.kind === "text" ? shape.fill === ink : shape.fill === ink || shape.stroke === ink,
  )
}

describe("odontogramSheetScene", () => {
  it("tiene las cuatro filas de la norma con su tamaño", () => {
    const scene = odontogramSheetScene([])
    expect(scene.rows.map((row) => [row.caption, row.width, row.height])).toEqual([
      [UPPER, 960, 156],
      ["Dentición temporal superior", 600, 156],
      ["Dentición temporal inferior", 600, 156],
      [LOWER, 960, 156],
    ])
    // Sin hallazgos, solo tinta negra y el blanco de las coronas.
    for (const row of scene.rows)
      for (const shape of row.shapes) {
        const colors = shape.kind === "text" ? [shape.fill] : [shape.fill, shape.stroke]
        for (const color of colors.filter(Boolean))
          expect([SHEET_INK.ink, SHEET_INK.paper]).toContain(color)
      }
  })

  it("pinta la caries de rojo en su cara y escribe su sigla", () => {
    const row = rowOf(
      [entry(16, "caries", { surface: "occlusal", details: { variant: "enamel" } })],
      UPPER,
    )
    expect(painted(row.shapes, SHEET_INK.red)).toEqual([
      // La 16 es la tercera pieza: corona en x 127, y 94 (siglas 32 + números 24 + 12 + raíz 26).
      {
        kind: "polygon",
        points: [
          [141, 108],
          [159, 108],
          [159, 124],
          [141, 124],
        ],
        fill: SHEET_INK.red,
      },
      {
        kind: "text",
        x: 150,
        y: 14,
        text: "CE",
        size: 10,
        fill: SHEET_INK.red,
        baseline: "alphabetic",
      },
    ])
  })

  it("pinta la restauración en buen estado de azul, del lado de su cara", () => {
    const row = rowOf(
      [
        entry(26, "definitive_restoration", {
          surface: "distal",
          details: { variant: "resin", quality: "good" },
        }),
      ],
      UPPER,
    )
    // La 26 está a la izquierda de la persona: su cara distal queda hacia afuera del dibujo.
    expect(painted(row.shapes, SHEET_INK.blue)).toEqual([
      {
        kind: "polygon",
        points: [
          [833, 94],
          [819, 108],
          [819, 124],
          [833, 138],
        ],
        fill: SHEET_INK.blue,
      },
      {
        kind: "text",
        x: 810,
        y: 14,
        text: "R",
        size: 10,
        fill: SHEET_INK.blue,
        baseline: "alphabetic",
      },
    ])
    // La de mal estado va de rojo.
    const poor = rowOf(
      [
        entry(26, "definitive_restoration", {
          surface: "distal",
          details: { variant: "resin", quality: "poor" },
        }),
      ],
      UPPER,
    )
    expect(painted(poor.shapes, SHEET_INK.red)).toHaveLength(2)
  })

  it("tacha la pieza ausente de la corona a la raíz", () => {
    const row = rowOf([entry(46, "missing_tooth")], LOWER)
    const line = { stroke: SHEET_INK.blue, strokeWidth: 2.4, cap: "round" }
    expect(painted(row.shapes, SHEET_INK.blue)).toEqual([
      { kind: "line", x1: 131, y1: 18, x2: 169, y2: 88, ...line },
      { kind: "line", x1: 169, y1: 18, x2: 131, y2: 88, ...line },
    ])
  })

  it("une el puente de pilar a pilar sobre las raíces", () => {
    const row = rowOf(
      [
        entry(24, "fixed_partial_denture", {
          details: { quality: "good", relatedTeeth: [24, 25, 27], abutmentTeeth: [24, 27] },
        }),
      ],
      UPPER,
    )
    const line = { stroke: SHEET_INK.blue, strokeWidth: 2.4, cap: "round" }
    expect(painted(row.shapes, SHEET_INK.blue)).toEqual([
      { kind: "line", x1: 668, y1: 63, x2: 892, y2: 63, ...line },
      { kind: "line", x1: 690, y1: 51, x2: 690, y2: 75, ...line },
      { kind: "line", x1: 870, y1: 51, x2: 870, y2: 75, ...line },
    ])
  })

  it("dibuja el diastema entre las dos piezas", () => {
    const row = rowOf([entry(31, "diastema", { details: { relatedTeeth: [31, 41] } })], LOWER)
    expect(painted(row.shapes, SHEET_INK.blue)).toEqual([
      { kind: "path", d: "M 475 28 Q 483 40 475 52", stroke: SHEET_INK.blue, strokeWidth: 2 },
      { kind: "path", d: "M 485 28 Q 477 40 485 52", stroke: SHEET_INK.blue, strokeWidth: 2 },
    ])
  })

  it("termina la flecha en un triángulo hacia donde va el trazo", () => {
    const row = rowOf([entry(23, "extruded_tooth")], UPPER)
    const [shaft, head] = painted(row.shapes, SHEET_INK.blue)
    // La 23 sale hacia abajo: de 143 a 154, bajo la corona.
    expect(shaft).toEqual({
      kind: "line",
      x1: 630,
      y1: 143,
      x2: 630,
      y2: 154,
      stroke: SHEET_INK.blue,
      strokeWidth: 1.6,
    })
    expect(head?.kind).toBe("polygon")
    const points = head?.kind === "polygon" ? head.points : []
    expect(points.map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))])).toEqual([
      [631.4, 151.2],
      [630, 154.67],
      [628.6, 151.2],
    ])
  })

  it("no pinta lo que está en revisión y lo dice en observaciones", () => {
    const scene = odontogramSheetScene([
      entry(16, "caries", { surface: "occlusal", needsReview: true }),
    ])
    expect(painted(scene.rows[0]!.shapes, SHEET_INK.red)).toEqual([])
    expect(scene.observations).toEqual(["Pieza 16: registro previo en revisión."])
  })

  it("escribe las notas una sola vez, con la pieza y su sigla", () => {
    const scene = odontogramSheetScene(
      [
        entry(16, "caries", {
          surface: "occlusal",
          note: "Profunda",
          details: { variant: "dentin" },
        }),
        entry(16, "caries", {
          surface: "mesial",
          note: "Profunda",
          details: { variant: "dentin" },
        }),
        entry(21, "clinical_observation", { note: "Sensible al frío" }),
      ],
      { specifications: "Control en 6 meses", observations: null },
    )
    expect(scene.specifications).toEqual(["Control en 6 meses", "Pieza 16 CD: Profunda"])
    expect(scene.observations).toEqual(["Pieza 21: Sensible al frío"])
  })
})

describe("las raíces de la hoja", () => {
  /** Cuántas raíces dibuja una pieza sola: los trazos en «V» de tinta antes de su corona. */
  function rootsOf(tooth: number): number {
    const row = odontogramSheetRow([tooth], isUpperTooth(tooth), [])
    return row.shapes.filter(
      (shape) => shape.kind === "path" && shape.stroke === SHEET_INK.ink && shape.strokeWidth === 1.6 && /^M[^M]*L[^M]*L[^M]*$/.test(shape.d),
    ).length
  }

  it("dibuja cada pieza con sus raíces, como la vista de frente", () => {
    // Molares de arriba con tres; los de abajo, también los de leche, con dos.
    expect([16, 26, 55, 65].map(rootsOf)).toEqual([3, 3, 3, 3])
    expect([36, 46, 75, 85].map(rootsOf)).toEqual([2, 2, 2, 2])
    // El primer premolar de arriba, dos; los demás premolares, una.
    expect([14, 24, 15, 34, 45].map(rootsOf)).toEqual([2, 2, 1, 1, 1])
    expect([11, 13, 31, 51].map(rootsOf)).toEqual([1, 1, 1, 1])
  })
})
