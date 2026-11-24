import { FDI_ADULT_ROWS, FDI_CHILD_ROWS } from "@odentia/dental"
import { archLayout } from "@odentia/dental/odontogram-arch"
import { drawnWidthMm } from "@odentia/dental/tooth-front"
import { describe, expect, it } from "vitest"
import { FRONT_PX_PER_MM, frontViewSize } from "./odontogram-front"
import { planMouth, singleArchRows, VIEWS_GAP } from "./odontogram-layout"

const U = FDI_ADULT_ROWS[0]!
const L = FDI_ADULT_ROWS[1]!
const PU = FDI_CHILD_ROWS[0]!
const PL = FDI_CHILD_ROWS[1]!

function rowsOf(mixed: boolean) {
  const arcade = (which: "upper" | "lower", split: boolean) =>
    singleArchRows(
      which === "upper" ? U : L,
      mixed ? (which === "upper" ? PU : PL) : null,
      which === "upper",
      split,
    )
  return {
    whole: mixed ? [U, PU, PL, L] : [U, L],
    narrow: [arcade("upper", true), arcade("lower", true)],
  }
}
const archOf = (mixed: boolean) => ({
  outer: { upper: U, lower: L },
  ...(mixed ? { inner: { upper: PU, lower: PL } } : {}),
})
const plan = (width: number, mixed: boolean) =>
  planMouth(width, { whole: rowsOf(mixed).whole }, archOf(mixed))

describe("el acomodo de la boca (24 nov: la vista de frente crecía con la pantalla)", () => {
  it("la vista de frente tiene su tamaño: en una pantalla ancha no crece", () => {
    const size = frontViewSize([U, L])
    expect(size.width).toBeGreaterThan(450)
    expect(size.width).toBeLessThan(500)
    expect(plan(1800, false)).toEqual(plan(1000, false))
  })

  it("las dos vistas en proporción: la muela mide lo mismo en el arco y de frente (y en la mixta, ninguna temporal baja de 16 px)", () => {
    for (const mixed of [false, true]) {
      const { archWidth, archAspect } = plan(1200, mixed)
      const layout = archLayout(
        archWidth,
        { upper: [], lower: L },
        mixed ? { upper: [], lower: PL } : undefined,
        { single: "lower", aspect: archAspect, byTooth: true },
      )
      const molar = layout.teeth.find((t) => t.tooth === 46)!
      const ratio = molar.w / (drawnWidthMm(46) * FRONT_PX_PER_MM)
      // En la mixta el arco crece para que sus temporales no bajen de 16 px.
      if (mixed) expect(ratio).toBeGreaterThanOrEqual(0.98)
      else expect(ratio).toBeCloseTo(1, 1)
      if (mixed) {
        const smallest = Math.min(...layout.teeth.filter((t) => t.inner).map((t) => t.w))
        expect(smallest).toBeGreaterThanOrEqual(15.9)
      }
    }
  })

  it("con la boca entera, la vista de frente va centrada en el alto de los dos arcos", () => {
    for (const mixed of [false, true]) {
      const p = plan(1200, mixed)
      expect(p.layout).toBe("whole")
      const column = p.archTop + 2 * p.archWidth * p.archAspect + p.archGap
      const front = p.frontTop + frontViewSize(rowsOf(mixed).whole).height
      expect(p.archTop + (column - p.archTop) / 2).toBeCloseTo(
        p.frontTop + (front - p.frontTop) / 2,
        3,
      )
    }
  })

  it("en el celular, la vista de frente llena el ancho, igual que el arco", () => {
    for (const mixed of [false, true]) {
      const narrow = [rowsOf(mixed).narrow[0]!, rowsOf(mixed).narrow[1]!]
      const p = planMouth(334, { whole: rowsOf(mixed).whole, narrow }, archOf(mixed))
      expect(p.layout).toBe("narrow")
      const widest = Math.max(...narrow.map((rows) => frontViewSize(rows, p.frontPxPerMm).width))
      expect(widest).toBeLessThanOrEqual(334.5)
      expect(widest).toBeGreaterThan(320)
      expect(p.archWidth).toBe(334)
    }
  })

  it("cada arco cabe al lado de su fila desde 1024 px de pantalla (871 px por dentro), también en la mixta", () => {
    for (const mixed of [false, true]) expect(plan(871, mixed).layout).toBe("whole")
  })

  it("con espacio, cada arco al lado de su fila; más angosta, los arcos arriba; en el celular, una arcada tras otra", () => {
    const order = ["narrow", "top", "whole"]
    for (const mixed of [false, true]) {
      const whole = plan(0, mixed)
      const front = frontViewSize(rowsOf(mixed).whole).width
      expect(plan(whole.archWidth + VIEWS_GAP + front, mixed).layout).toBe("whole")
      expect(plan(whole.archWidth + VIEWS_GAP + front - 1, mixed).layout).not.toBe("whole")
      expect(plan(334, mixed).layout).toBe("narrow")
      // A 700 px (la atención con la pieza al lado), las dos arcadas: los arcos arriba, más chicos.
      const atencion = plan(700, mixed)
      expect(atencion.layout).toBe("top")
      expect(2 * atencion.archWidth + VIEWS_GAP).toBeLessThanOrEqual(700)
      // Al angostarse, el acomodo solo baja de escalón: nunca vuelve a uno más ancho.
      let last = order.length - 1
      for (let width = 1300; width >= 300; width -= 5) {
        const step = order.indexOf(plan(width, mixed).layout)
        expect(step).toBeLessThanOrEqual(last)
        last = step
      }
    }
  })

  it("en el celular (334 px por dentro) la arcada partida y su arco entran", () => {
    for (const mixed of [false, true]) {
      const p = plan(334, mixed)
      expect(p.layout).toBe("narrow")
      for (const rows of rowsOf(mixed).narrow)
        expect(frontViewSize(rows).width).toBeLessThanOrEqual(334)
      expect(p.archWidth).toBeLessThanOrEqual(334)
    }
  })

  it("ninguna pieza de frente baja de 24 px para el dedo, con su ancho y el borde que se toca", () => {
    // Permanente y mixta (las temporales de la mixta se tocan en el lugar de su reemplazo).
    const k = plan(1200, false).frontPxPerMm
    for (const row of FDI_ADULT_ROWS)
      for (const tooth of row) expect(drawnWidthMm(tooth) * k + 2).toBeGreaterThanOrEqual(24)
    // Solo temporales: su propio tamaño.
    const child = planMouth(
      1200,
      { whole: [PU, PL] },
      { outer: { upper: PU, lower: PL } },
    ).frontPxPerMm
    for (const row of FDI_CHILD_ROWS)
      for (const tooth of row) expect(drawnWidthMm(tooth) * child + 2).toBeGreaterThanOrEqual(24)
  })

  it("en el celular, las permanentes en dos de 8 y las de leche enteras en su fila, del lado de las coronas", () => {
    expect(singleArchRows(U, PU, true, true)).toEqual([U.slice(0, 8), U.slice(8), [...PU]])
    expect(singleArchRows(L, PL, false, true)).toEqual([[...PL], L.slice(0, 8), L.slice(8)])
    expect(singleArchRows(U, PU, true, false)).toEqual([[...U], [...PU]])
    expect(singleArchRows([], PU, true, true)).toEqual([PU.slice(0, 5), PU.slice(5)])
  })
})
