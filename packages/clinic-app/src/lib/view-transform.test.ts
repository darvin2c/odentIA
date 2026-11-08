import { describe, expect, it } from "vitest"
import { cbctNifti } from "./cbct-nifti"
import { memoryBudget } from "./cbct-volume"
import {
  clampZoom,
  FITTED,
  fromOriented,
  type Orientation,
  orientedSize,
  type QuarterTurns,
  toggleZoom,
  toOriented,
  zoomAt,
} from "./view-transform"

const frame = { width: 400, height: 300 }

describe("girar y voltear solo para mirar", () => {
  const orientations: Orientation[] = ([0, 1, 2, 3] as QuarterTurns[]).flatMap((turns) => [
    { turns, flip: false },
    { turns, flip: true },
  ])
  it.each(orientations.map((o) => [`${o.turns} cuartos${o.flip ? ", volteada" : ""}`, o] as const))(
    "un punto marcado en la imagen girada (%s) vuelve al mismo punto de la original",
    (_name, o) => {
      const p = { x: 30, y: 12 }
      const shown = toOriented(p, 100, 40, o)
      const size = orientedSize(100, 40, o)
      expect(shown.x).toBeGreaterThanOrEqual(0)
      expect(shown.x).toBeLessThanOrEqual(size.width)
      expect(shown.y).toBeLessThanOrEqual(size.height)
      expect(fromOriented(shown, 100, 40, o)).toEqual(p)
    },
  )
  it("un cuarto de vuelta lleva la esquina de arriba a la izquierda a la de arriba a la derecha", () => {
    expect(toOriented({ x: 0, y: 0 }, 100, 40, { turns: 1, flip: false })).toEqual({ x: 40, y: 0 })
    expect(orientedSize(100, 40, { turns: 1, flip: false })).toEqual({ width: 40, height: 100 })
  })
  it("voltear cambia la derecha por la izquierda", () => {
    expect(toOriented({ x: 10, y: 5 }, 100, 40, { turns: 0, flip: true })).toEqual({ x: 90, y: 5 })
  })
})

describe("acercar sin perder la imagen de vista", () => {
  it("acercar en un punto lo deja en su lugar", () => {
    const at = { x: 100, y: 80 }
    const z = zoomAt(FITTED, 2, at, frame)
    expect(z.scale).toBe(2)
    // El punto de la imagen bajo el puntero sigue bajo el puntero.
    expect((at.x - z.x) / z.scale).toBeCloseTo(at.x)
    expect((at.y - z.y) / z.scale).toBeCloseTo(at.y)
  })
  it("no se aleja más que ajustada ni se acerca más de 8×", () => {
    expect(zoomAt(FITTED, 0.5, { x: 10, y: 10 }, frame)).toEqual(FITTED)
    expect(zoomAt({ scale: 6, x: 0, y: 0 }, 4, { x: 0, y: 0 }, frame).scale).toBe(8)
  })
  it("arrastrar no deja ver fuera de la imagen", () => {
    expect(clampZoom({ scale: 2, x: 50, y: -900 }, frame)).toEqual({ scale: 2, x: 0, y: -300 })
  })
  it("doble clic alterna entre ajustada y 2×", () => {
    const near = toggleZoom(FITTED, { x: 200, y: 150 }, frame)
    expect(near.scale).toBe(2)
    expect(toggleZoom(near, { x: 0, y: 0 }, frame)).toEqual(FITTED)
  })
})

describe("la tomografía en el celular y en 3D", () => {
  it("si el navegador no dice su memoria, en un celular se supone poca", () => {
    expect(memoryBudget(undefined, true)).toBe(0.5 * 1024 ** 3)
    expect(memoryBudget(undefined, false)).toBe(1.5 * 1024 ** 3)
    expect(memoryBudget(4, true)).toBe(1024 ** 3)
  })
  it("el 3D usa una copia reducida, con su escala y en enteros de 16 bits", () => {
    const nx = 600
    const ny = 10
    const nz = 4
    const data = new Int16Array(nx * ny * nz)
    for (let i = 0; i < data.length; i++) data[i] = i % 1000
    const volume = {
      nx,
      ny,
      nz,
      sx: 0.2,
      sy: 0.2,
      sz: 0.25,
      data,
      range: { min: 0, max: 999 },
      presets: {} as never,
      hounsfield: false,
      fileWindow: null,
    }
    const { buffer, factor } = cbctNifti(volume, 256)
    expect(factor).toBe(3)
    const view = new DataView(buffer)
    expect(view.getInt32(0, true)).toBe(348)
    expect([1, 2, 3].map((i) => view.getInt16(40 + i * 2, true))).toEqual([200, 3, 1])
    expect(view.getInt16(70, true)).toBe(4)
    expect(view.getFloat32(80, true)).toBeCloseTo(0.6)
    expect(new TextDecoder().decode(new Uint8Array(buffer, 344, 3))).toBe("n+1")
    const voxels = new Int16Array(buffer, 352)
    expect(voxels.length).toBe(200 * 3 * 1)
    // Vóxel (1, 1, 0) de la copia = (3, 3, 0) del original.
    expect(voxels[1 + 200]).toBe(data[3 + 3 * nx])
  })
})
