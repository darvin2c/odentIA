import { cbctDemoTeeth, generateCbctPhantom } from "@odentia/dental"
import { describe, expect, it } from "vitest"
import { crossSection, detectArch, occlusalSample, panorama, panoramaRows, sampleCurve, toothAt, toothIndex } from "./cbct-arch"
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

  it("la panorámica de los maxilares es la misma imagen, recortada alrededor del plano oclusal", () => {
    const full = panorama(volume, curve)
    const [from, to] = panoramaRows(volume, arch!.z)
    const jaws = panorama(volume, curve, 12, from, to)
    expect(jaws.zTop).toBe(Math.min(volume.nz - 1, to))
    expect(jaws.height).toBe(jaws.zTop - Math.max(0, from) + 1)
    const fullRow = volume.nz - 1 - jaws.zTop
    const column = Math.floor(curve.length / 2)
    for (const r of [0, Math.floor(jaws.height / 2), jaws.height - 1])
      expect(jaws.values[r * jaws.width + column]).toBe(full.values[(fullRow + r) * full.width + column])
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

/**
 * Un arco como el de una tomografía real (la de 3D Slicer): coronas de 9 mm de
 * grosor con el esmalte por fuera, el arco de arriba 3 mm por delante del de
 * abajo y una U de frente redondo y lados rectos, que una parábola sigue solo a
 * grandes rasgos. Con aire, tejido blando, hueso, dentina y esmalte.
 */
function thickArchVolume(): ReturnType<typeof volumeFromSlices> {
  const n = 160
  const slices = 24
  // La U en mm: media elipse adelante y lados rectos de 12 mm hacia atrás.
  const distanceTo = (grow: number) => {
    const curve: { x: number; y: number }[] = []
    for (let k = 0; k <= 200; k++) {
      const t = Math.PI + (Math.PI * k) / 200
      curve.push({ x: 40 + (26 + grow) * Math.cos(t), y: 50 + (28 + grow) * Math.sin(t) })
    }
    for (let k = 1; k <= 24; k++) {
      curve.unshift({ x: 14 - grow, y: 50 + k / 2 })
      curve.push({ x: 66 + grow, y: 50 + k / 2 })
    }
    const distance = new Float32Array(n * n)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let best = Infinity
        for (const p of curve) best = Math.min(best, Math.hypot(x * V - p.x, y * V - p.y))
        distance[y * n + x] = best
      }
    return distance
  }
  const lower = distanceTo(0)
  const upper = distanceTo(3)
  const data = Array.from({ length: slices }, (_, z) => {
    const crown = z >= 6 && z <= 11 ? lower : z >= 13 && z <= 18 ? upper : null
    const slice = new Int16Array(n * n)
    for (let i = 0; i < n * n; i++) {
      const x = (i % n) * V - 40
      const y = Math.floor(i / n) * V - 45
      let value = Math.hypot(x, y) < 40 ? 400 : 0
      if (lower[i]! <= 8) value = 900
      const d = crown?.[i]
      if (d !== undefined && d <= 4.5) value = d >= 3 ? 2400 + ((i * 7919) % 600) : 1700
      slice[i] = value
    }
    return slice
  })
  return volumeFromSlices(data, { nx: n, ny: n, sx: V, sy: V, sz: V })
}

describe("arco de una tomografía real", () => {
  it("propone el arco aunque los dientes sean gruesos y la U no sea una parábola", () => {
    const arch = detectArch(thickArchVolume())
    expect(arch).not.toBeNull()
    // El punto del medio cae sobre los incisivos (x = 40 mm, y = 22 mm).
    const middle = arch!.control[2]!
    expect(Math.abs(middle.x * V - 40)).toBeLessThan(3)
    expect(Math.abs(middle.y * V - 22)).toBeLessThan(5)
    expect(arch!.z).toBeGreaterThanOrEqual(8)
    expect(arch!.z).toBeLessThanOrEqual(16)
  })

  it("la miniatura sale del corte con dientes, no del medio de la serie", () => {
    const n = 80
    // Tejido blando con un anillo de hueso, como un corte del cráneo; esmalte solo en uno.
    const slice = (teeth: boolean) =>
      Int16Array.from({ length: n * n }, (_, i) => {
        const x = (i % n) - 40
        const y = Math.floor(i / n) - 40
        const r = Math.hypot(x, y)
        if (teeth && Math.abs(y + 10 - 0.02 * x * x) < 3 && Math.abs(x) < 25) return 2400 + (i % 500)
        return r < 30 ? (r > 26 ? 1300 : 400) : 0
      })
    const pick = occlusalSample(Array.from({ length: 10 }, (_, k) => slice(k === 2)))
    expect(pick?.index).toBe(2)
    expect(pick!.window.center).toBeGreaterThan(400)
  })

  it("en el fantoma, la miniatura cae en la banda oclusal", () => {
    const plane = volume.nx * volume.ny
    const picks = Array.from({ length: 24 }, (_, k) => Math.floor(((k + 0.5) * volume.nz) / 24))
    const pick = occlusalSample(picks.map((z) => volume.data.slice(z * plane, (z + 1) * plane)))!
    expect(Math.abs(phantom.sliceZ[picks[pick.index]!]!)).toBeLessThan(9)
  })

  it("sin dientes en forma de arco no propone nada", () => {
    const n = 120
    // Un anillo de hueso denso, como un corte del cráneo: no abre hacia atrás.
    const ring = Array.from({ length: 12 }, () =>
      Int16Array.from({ length: n * n }, (_, i) => {
        const r = Math.hypot((i % n) - 60, Math.floor(i / n) - 60) * V
        return r > 24 && r < 27 ? 1800 + Math.round((27 - r) * 300) : r <= 24 ? 400 : 0
      }),
    )
    expect(detectArch(volumeFromSlices(ring, { nx: n, ny: n, sx: V, sy: V, sz: V }))).toBeNull()
  })
})
