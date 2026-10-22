import { encodeDemoCtSlice, generateCbctPhantom } from "@odentia/clinical"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  computePresets,
  loadCbctVolume,
  planeAngleDeg,
  planeDistanceMm,
  planeImage,
  volumeFromSlices,
} from "./cbct-volume"

const phantom = generateCbctPhantom({ size: 80, slices: 72, voxelMm: 1 })
const toHu = (slice: Uint16Array) => Int16Array.from(slice, (v) => v - 1000)

afterEach(() => vi.unstubAllGlobals())

describe("volumen de la tomografía", () => {
  it("ordena los cortes por su posición aunque lleguen desordenados", async () => {
    const files = phantom.data.map((pixels, k) =>
      encodeDemoCtSlice({
        width: phantom.size,
        height: phantom.size,
        pixels,
        voxelMm: phantom.voxelMm,
        position: [phantom.origin[0], phantom.origin[1], phantom.sliceZ[k]!],
        // El número de instancia al revés: manda la posición, no el número.
        instanceNumber: phantom.slices - k,
        studyUid: "2.25.1",
        seriesUid: "2.25.1.2",
        frameOfReferenceUid: "2.25.1.3",
        sopUid: `2.25.1.4.${k + 1}`,
      }),
    )
    const shuffled = files.map((bytes, k) => ({ bytes, k })).sort((a, b) => ((a.k * 37) % 72) - ((b.k * 37) % 72))
    vi.stubGlobal("fetch", async (url: string) => {
      const k = Number(url.split("/").pop())
      return new Response(new Uint8Array(files[k]!))
    })
    const volume = await loadCbctVolume(
      "prueba",
      shuffled.map(({ bytes, k }) => ({ index: k, url: `memoria/${k}`, sizeBytes: bytes.length, seriesInstanceUid: "2.25.1.2" })),
    )
    expect(volume).toMatchObject({ nx: 80, ny: 80, nz: 72, sx: 1, sy: 1 })
    expect(volume.sz).toBeCloseTo(1)
    const plane = 80 * 80
    for (const k of [0, 30, 71]) {
      expect(Array.from(volume.data.subarray(k * plane, k * plane + 40))).toEqual(
        Array.from(toHu(phantom.data[k]!).subarray(0, 40)),
      )
    }
  })

  it("orienta los cortes como el radiólogo: arriba es arriba", () => {
    const volume = volumeFromSlices(phantom.data.map(toHu), { nx: 80, ny: 80, sx: 1, sy: 1, sz: 1 })
    const coronal = planeImage(volume, "coronal", 40)
    expect(coronal).toMatchObject({ width: 80, height: 72, colMm: 1, rowMm: 1 })
    // Fila 0 del coronal = el corte más alto del volumen.
    expect(coronal.values[5]).toBe(volume.data[71 * 6400 + 40 * 80 + 5])
    const sagittal = planeImage(volume, "sagittal", 10)
    expect(sagittal.values[3]).toBe(volume.data[71 * 6400 + 3 * 80 + 10])
  })

  it("calcula los brillos con los grises del propio estudio", () => {
    const volume = volumeFromSlices(phantom.data.map(toHu), { nx: 80, ny: 80, sx: 1, sy: 1, sz: 1 })
    const { hueso, diente, blando } = volume.presets
    // El fantoma: partes blandas ~35 HU, hueso 470–1450, esmalte ~2850.
    expect(blando.center).toBeLessThan(hueso.center)
    expect(hueso.center).toBeLessThan(diente.center)
    expect(diente.center + diente.width / 2).toBeGreaterThan(1800)
    // El hueso esponjoso (~470 HU) se ve en grises con «Hueso», no negro ni blanco,
    // también en otro campo de visión y otro vóxel (el de la e2e).
    const gray = (w: { center: number; width: number }, v: number) => (v - (w.center - w.width / 2)) / w.width
    expect(gray(hueso, 470)).toBeGreaterThan(0.1)
    expect(gray(hueso, 470)).toBeLessThan(0.6)
    const other = generateCbctPhantom({ size: 128, slices: 100, voxelMm: 0.6 })
    const otherVolume = volumeFromSlices(other.data.map(toHu), { nx: 128, ny: 128, sx: 0.6, sy: 0.6, sz: 0.6 })
    expect(gray(otherVolume.presets.hueso, 470)).toBeGreaterThan(0.1)
    expect(gray(otherVolume.presets.hueso, 470)).toBeLessThan(0.6)
    // Corridos 1000 (otro equipo, otra escala): los brillos se corren con ellos.
    const shifted = Int16Array.from(volume.data, (v) => v + 1000)
    const moved = computePresets(shifted, { min: volume.range.min + 1000, max: volume.range.max + 1000 })
    expect(moved.hueso.center).toBeCloseTo(hueso.center + 1000, -1)
  })

  it("mide distancias y ángulos con el espaciado del plano", () => {
    const image = { colMm: 0.2, rowMm: 0.4 }
    expect(planeDistanceMm(image, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(2)
    expect(planeDistanceMm(image, { x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(4)
    expect(planeAngleDeg({ colMm: 1, rowMm: 1 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90)
  })
})
