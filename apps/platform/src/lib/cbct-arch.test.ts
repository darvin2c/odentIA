import { cbctDemoTeeth, generateCbctPhantom } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { crossSection, detectArch, panorama, sampleCurve, toothAt, toothIndex } from "./cbct-arch"
import { volumeFromSlices } from "./cbct-volume"

const V = 0.5
const phantom = generateCbctPhantom({ size: 160, slices: 144, voxelMm: V })
const volume = volumeFromSlices(
  phantom.data.map((slice) => Int16Array.from(slice, (v) => v - 1000)),
  { nx: 160, ny: 160, sx: V, sy: V, sz: V },
)
/** El arco del fantoma en mm del paciente: y = −20 + 0,035 · x². */
const archY = (x: number) => -20 + 0.035 * x * x
const toPatient = (p: { x: number; y: number }) => ({
  x: phantom.origin[0] + p.x * V,
  y: phantom.origin[1] + p.y * V,
})
const zOf = (row: number) => phantom.sliceZ[volume.nz - 1 - row]!

describe("arco, panorámica y cortes transversales", () => {
  const arch = detectArch(volume)
  const curve = arch ? sampleCurve(volume, arch.control) : []

  it("propone el arco sobre los dientes, de la derecha a la izquierda del paciente", () => {
    expect(arch).not.toBeNull()
    expect(arch!.control).toHaveLength(5)
    for (const p of arch!.control.map(toPatient)) expect(Math.abs(p.y - archY(p.x))).toBeLessThan(3.5) // dentro del ancho de una corona
    const xs = arch!.control.map((p) => toPatient(p).x)
    expect(xs[0]!).toBeLessThan(-20)
    expect(xs[4]!).toBeGreaterThan(20)
    // La banda oclusal está cerca de z = 0.
    expect(Math.abs(phantom.sliceZ[arch!.z]!)).toBeLessThan(9)
  })

  it("la normal apunta hacia afuera del arco", () => {
    const front = curve.reduce((best, c) => (c.y < best.y ? c : best))
    expect(front.ny).toBeLessThan(0) // en los incisivos, afuera es adelante
  })

  it("la panorámica tiene un punto por mm de arco y el alto del volumen", () => {
    const pano = panorama(volume, curve)
    expect(pano.width).toBe(curve.length)
    expect(pano.height).toBe(volume.nz)
    expect(pano.colMm).toBeCloseTo(V)
  })

  it("«Ir a la pieza» cae cerca de la 36 y el corte muestra su reborde sin diente", () => {
    const real = cbctDemoTeeth().find((t) => t.fdi === 37)!
    const at = toothIndex(curve, 36)!
    expect(at).not.toBeNull()
    expect(toothAt(curve, at, "lower")).toBe(36)
    // Centro real de la 36 (ausente): entre la 35 y la 37 del fantoma.
    const s36 = real.s - (real.width + 10) / 2
    const sMid = curve.reduce((best, c) => (c.y < best.y ? c : best)).s
    expect(Math.abs(curve[at]!.s - sMid - s36)).toBeLessThan(5)

    // En el centro del corte, de arriba hacia abajo: aire o encía, luego el
    // reborde óseo cerca de z = −11,5 mm (no hay corona) y el conducto más abajo.
    const cross = crossSection(volume, curve, at)
    const center = Math.round((cross.width - 1) / 2)
    const column = Array.from({ length: cross.height }, (_, r) => cross.values[r * cross.width + center]!)
    const lowerHalf = column.map((v, r) => ({ v, z: zOf(r) })).filter(({ z }) => z < -5)
    const crest = lowerHalf.find(({ v }) => v > 900)
    expect(crest).toBeDefined()
    expect(Math.abs(crest!.z - -11.5)).toBeLessThan(2)
    expect(lowerHalf.some(({ v, z }) => z > -11 && v > 2000)).toBe(false)
  })
})
