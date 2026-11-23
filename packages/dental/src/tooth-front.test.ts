import { describe, expect, it } from "vitest"
import { FDI_ADULT_ROWS, FDI_CHILD_ROWS } from "./anatomy.js"
import { archLayout } from "./odontogram-arch.js"
import {
  canalPaths,
  frontRow,
  frontRowWidthMm,
  frontSpecOf,
  mesialIsRight,
  postRootCenter,
} from "./tooth-front.js"
import { type FrontEntry, frontMarksOf, frontRowMarksOf } from "./tooth-front-marks.js"

const entry = (
  toothNumber: number,
  condition: string,
  extra: Partial<FrontEntry> = {},
): FrontEntry => ({
  id: `${toothNumber}-${condition}-${extra.surface ?? ""}`,
  toothNumber,
  condition,
  ...extra,
})

describe("la boca de frente", () => {
  it("tiene medidas para las 52 piezas y cuenta las raíces que se ven de frente", () => {
    for (const row of [...FDI_ADULT_ROWS, ...FDI_CHILD_ROWS])
      for (const tooth of row) expect(frontSpecOf(tooth).mm).toBeGreaterThan(0)
    expect(frontSpecOf(14).roots).toBe(2)
    expect(frontSpecOf(15).roots).toBe(1)
    expect(frontSpecOf(16).roots).toBe(3)
    expect(frontSpecOf(46).roots).toBe(2)
    expect(frontSpecOf(85).roots).toBe(2)
    expect(() => frontSpecOf(19)).toThrow()
  })

  it("un conducto por raíz: uno en la 15, dos en la 46, tres en la 16", () => {
    expect(canalPaths(frontSpecOf(15), 30, 40, 60)).toHaveLength(1)
    expect(canalPaths(frontSpecOf(46), 30, 40, 60)).toHaveLength(2)
    expect(canalPaths(frontSpecOf(16), 30, 40, 60)).toHaveLength(3)
  })

  it("el perno del molar inferior va en la raíz distal", () => {
    // La 46 se ve a la izquierda: su distal queda a la izquierda del dibujo.
    expect(mesialIsRight(46)).toBe(true)
    expect(postRootCenter(46, frontSpecOf(46))).toBeLessThan(0.5)
    expect(postRootCenter(36, frontSpecOf(36))).toBeGreaterThan(0.5)
    expect(postRootCenter(15, frontSpecOf(15))).toBe(0.5)
  })

  it("una fila pone las piezas sin pisarse, con más espacio en la línea media, y la encía las envuelve", () => {
    const upper = [...FDI_ADULT_ROWS[0]!]
    const row = frontRow(upper, { scale: 5, left: 10, yOcc: 200 })
    expect(row.up).toBe(true)
    for (let i = 1; i < row.teeth.length; i++) {
      const prev = row.teeth[i - 1]!
      expect(row.teeth[i]!.x).toBeGreaterThan(prev.x + prev.w)
    }
    const gap = (i: number) => row.teeth[i]!.x - (row.teeth[i - 1]!.x + row.teeth[i - 1]!.w)
    expect(gap(8)).toBeGreaterThan(gap(3))
    // Las de arriba: la raíz sube y la encía llega más allá de la raíz más larga.
    const longest = Math.max(...row.teeth.map((t) => t.ch + t.rl))
    expect(row.top).toBeLessThan(200 - longest)
    expect(row.bottom).toBe(200)
    expect(row.right - row.left).toBeCloseTo(frontRowWidthMm(upper) * 5 + 2 * 2.6 * 5, 0)
    expect(row.gum.startsWith("M")).toBe(true)
    const lower = frontRow([...FDI_ADULT_ROWS[1]!], { scale: 5, left: 10, yOcc: 300 })
    expect(lower.up).toBe(false)
    expect(lower.top).toBe(300)
  })
})

describe("lo que se dibuja de frente", () => {
  const good = { quality: "good" as const }

  it("la 15 con endodoncia, perno y corona muestra los tres en azul", () => {
    const marks = frontMarksOf(15, [
      entry(15, "root_canal_treatment", { details: good }),
      entry(15, "post_and_core", { details: good }),
      entry(15, "crown", { details: good }),
    ])
    expect(marks).toMatchObject({ body: "tooth", canals: "blue", post: "blue", crown: "blue" })
  })

  it("lo que no tiene estado elegido o está en revisión no se dibuja", () => {
    const marks = frontMarksOf(15, [
      entry(15, "post_and_core"),
      entry(15, "caries", { surface: "occlusal", needsReview: true }),
    ])
    expect(marks.post).toBeUndefined()
    expect(marks.surfaces).toEqual([])
  })

  it("el implante va en vez de la raíz, con su corona si la tiene", () => {
    const marks = frontMarksOf(36, [
      entry(36, "implant", { details: good }),
      entry(36, "crown", { details: good }),
    ])
    expect(marks).toMatchObject({ body: "implant", implantCrown: "blue" })
  })

  it("en el puente, la pieza que falta se dibuja como póntico y los pilares con su corona", () => {
    const bridge = entry(44, "fixed_partial_denture", {
      details: { quality: "good", relatedTeeth: [44, 45, 46], abutmentTeeth: [44, 46] },
    })
    expect(frontMarksOf(45, [bridge, entry(45, "missing_tooth")]).body).toBe("pontic")
    expect(frontMarksOf(44, [bridge])).toMatchObject({ body: "tooth", crown: "blue" })
    const marks = frontRowMarksOf([...FDI_ADULT_ROWS[1]!], (tooth) =>
      [44, 45, 46].includes(tooth) ? [bridge] : [],
    )
    expect(marks).toEqual([{ kind: "bridge", paint: "blue", teeth: [46, 45, 44], split: false }])
  })

  it("el resto radicular es solo la raíz, en rojo, y la retenida queda dentro de la encía", () => {
    expect(frontMarksOf(18, [entry(18, "root_remnant")])).toMatchObject({
      body: "remnant",
      bodyPaint: "red",
    })
    const impacted = frontMarksOf(48, [entry(48, "impaction")])
    expect(impacted.buried).toBe(true)
    expect(impacted.shift).toBeGreaterThan(1)
  })

  it("las caras: la oclusal en el borde, la mesial y la distal a los lados, la palatina no se ve", () => {
    const marks = frontMarksOf(26, [
      entry(26, "caries", { surface: "occlusal" }),
      entry(26, "caries", { surface: "palatal" }),
      entry(26, "definitive_restoration", { surface: "mesial", details: good }),
    ])
    expect(marks.surfaces).toEqual([
      { zone: "edge", paint: "red", style: "fill" },
      { zone: "mesial", paint: "blue", style: "fill" },
    ])
  })

  it("la movilidad lleva su grado", () => {
    expect(
      frontMarksOf(17, [entry(17, "pathological_mobility", { details: { grade: 2 } })]).mobility,
    ).toEqual({
      paint: "red",
      grade: 2,
    })
  })

  it("el arco de la vista de arriba puede ir más bajo, una arcada por arco", () => {
    const layout = archLayout(300, { upper: FDI_ADULT_ROWS[0]!, lower: [] }, undefined, {
      single: "upper",
      aspect: 0.8,
    })
    expect(layout.height).toBeCloseTo(240)
    expect(layout.teeth).toHaveLength(16)
  })
})
