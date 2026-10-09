import { encodeDemoDicom } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { DicomUnsupportedError, decodeDicom, distanceMm, renderDicom } from "./dicom"

function demo() {
  const width = 40
  const height = 20
  const pixels = new Uint16Array(width * height)
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i % width) * 100
  const bytes = encodeDemoDicom({ width, height, pixels, pixelSpacingMm: [0.05, 0.04] })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe("visor DICOM", () => {
  it("lee una intraoral de 16 bits con su ventana y su espaciado del detector", async () => {
    const image = await decodeDicom(demo())
    expect(image).toMatchObject({ width: 40, height: 20, monochrome1: false, frames: 1 })
    expect(image.window).toEqual({ center: 2048, width: 4096 })
    expect(image.range).toEqual({ min: 0, max: 3900 })
    expect(image.pixelSpacing).toEqual([0.05, 0.04])
    expect(image.meta.modality).toBe("IO")
  })
  it("aplica la ventana lineal y la inversión", async () => {
    const image = await decodeDicom(demo())
    const narrow = renderDicom(image, { center: 1000, width: 2, invert: false })
    expect(narrow[0]).toBe(0) // 0 queda bajo la ventana
    expect(narrow[39 * 4]).toBe(255) // 3900 queda sobre la ventana
    const inverted = renderDicom(image, { center: 1000, width: 2, invert: true })
    expect(inverted[0]).toBe(255)
  })
  it("mide en mm con el espaciado y sin él no inventa medidas", async () => {
    const image = await decodeDicom(demo())
    expect(distanceMm(image, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0.4)
    expect(distanceMm({ pixelSpacing: null }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeNull()
  })
  it("informa compresiones no soportadas", async () => {
    const bytes = new Uint8Array(demo())
    const text = new TextDecoder("latin1").decode(bytes)
    const at = text.indexOf("1.2.840.10008.1.2.1\0", 140)
    bytes.set(new TextEncoder().encode("1.2.840.10008.1.2.5\0"), at)
    await expect(decodeDicom(bytes.buffer)).rejects.toBeInstanceOf(DicomUnsupportedError)
  })
})
