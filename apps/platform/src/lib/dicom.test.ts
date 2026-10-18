import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { DICOM_SAMPLES, type DicomSample, encodeDemoDicom } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { DicomUnsupportedError, decodeDicom, distanceMm, renderDicom } from "./dicom"

const require = createRequire(import.meta.url)

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Muestra de `@odentia/clinical/samples/dicom`, generada con pydicom y GDCM. */
function sample(file: string): Uint8Array {
  return new Uint8Array(readFileSync(require.resolve(`@odentia/clinical/samples/dicom/${file}`)))
}

function demo() {
  const width = 40
  const height = 20
  const pixels = new Uint16Array(width * height)
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i % width) * 100
  const bytes = encodeDemoDicom({ width, height, pixels, pixelSpacingMm: [0.05, 0.04] })
  return arrayBuffer(bytes)
}

/** Reemplaza un texto del archivo por otro del mismo largo (valores de cabecera). */
function patch(bytes: Uint8Array, from: string, to: string): ArrayBuffer {
  expect(to.length).toBe(from.length)
  const out = new Uint8Array(bytes)
  const at = new TextDecoder("latin1").decode(out).indexOf(from)
  expect(at).toBeGreaterThan(0)
  out.set(new TextEncoder().encode(to), at)
  return arrayBuffer(out)
}

describe("visor DICOM", () => {
  it("lee una intraoral de 16 bits con su ventana y su espaciado del detector", async () => {
    const image = await decodeDicom(demo())
    expect(image).toMatchObject({ width: 40, height: 20, monochrome1: false, frames: 1, frame: 0 })
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
  it("descarta los bits que quedan fuera de Bits Stored", async () => {
    const pixels = new Uint16Array([0xf00f, 4095])
    const image = await decodeDicom(arrayBuffer(encodeDemoDicom({ width: 2, height: 1, pixels })))
    expect(Array.from(image.values ?? [])).toEqual([15, 4095])
  })
  it("recorre los cuadros de un archivo sin comprimir", async () => {
    const pixels = new Uint16Array(8)
    pixels.fill(100, 0, 4)
    pixels.fill(900, 4, 8)
    const buffer = arrayBuffer(encodeDemoDicom({ width: 2, height: 2, pixels, frames: 2 }))
    const second = await decodeDicom(buffer, 1)
    expect(second).toMatchObject({ frames: 2, frame: 1 })
    expect(Array.from(second.values ?? [])).toEqual([900, 900, 900, 900])
    await expect(decodeDicom(buffer, 2)).rejects.toBeInstanceOf(DicomUnsupportedError)
  })
})

describe("visor DICOM: una prueba por sintaxis de transferencia", () => {
  const reference = () => decodeDicom(arrayBuffer(sample("explicit-le.dcm"))).then((r) => r.values ?? new Float32Array())

  it.each(DICOM_SAMPLES.map((s) => [s.name, s] as [string, DicomSample]))(
    "%s da la misma imagen que la muestra sin comprimir",
    async (_name, s) => {
      const expected = await reference()
      const image = await decodeDicom(arrayBuffer(sample(s.file)))
      expect(image.meta.transferSyntax).toBe(s.transferSyntax)
      expect(image).toMatchObject({ width: 200, height: 150, frames: s.frames, frame: 0 })
      expect(image.pixelSpacing).toEqual([0.1, 0.1])
      const values = image.values
      expect(values).not.toBeNull()
      // Las muestras de 8 bits se llevan a la escala de 12 para comparar.
      const scale = s.transferSyntax.endsWith(".4.50") ? 4095 / 255 : 1
      let worst = 0
      for (let i = 0; i < expected.length; i++) {
        worst = Math.max(worst, Math.abs((values?.[i] ?? 0) * scale - (expected[i] ?? 0)))
      }
      expect(worst).toBeLessThanOrEqual(s.maxError + (scale > 1 ? 8 : 0))
    },
  )

  it("recorre los cuadros de un archivo comprimido", async () => {
    const expected = await reference()
    const buffer = arrayBuffer(sample("rle-multiframe.dcm"))
    const first = await decodeDicom(buffer, 0)
    const third = await decodeDicom(buffer, 2)
    expect(Array.from(first.values ?? [])).toEqual(Array.from(expected))
    expect(third.frame).toBe(2)
    // La lesión se movió: el tercer cuadro no repite el primero.
    expect(Array.from(third.values ?? [])).not.toEqual(Array.from(expected))
    await expect(decodeDicom(buffer, 3)).rejects.toBeInstanceOf(DicomUnsupportedError)
  })
})

describe("visor DICOM: lo que no lee lo dice, nunca pinta una imagen errónea", () => {
  it("informa una compresión desconocida", async () => {
    const buffer = patch(new Uint8Array(demo()), "1.2.840.10008.1.2.1\0", "1.2.840.10008.1.2.9\0")
    await expect(decodeDicom(buffer)).rejects.toThrow(/Compresión|compresión/)
    await expect(decodeDicom(buffer)).rejects.toBeInstanceOf(DicomUnsupportedError)
  })
  it("informa un color que no sabe convertir", async () => {
    const buffer = patch(new Uint8Array(demo()), "MONOCHROME2 ", "YBR_FULL_422")
    await expect(decodeDicom(buffer)).rejects.toBeInstanceOf(DicomUnsupportedError)
  })
  it("rechaza una imagen comprimida que no coincide con su cabecera", async () => {
    const bytes = sample("jpeg2000-lossless.dcm")
    // Filas (0028,0010) en Explicit VR Little Endian: 150 pasa a 151.
    const tag = [0x28, 0x00, 0x10, 0x00, 0x55, 0x53, 0x02, 0x00]
    const at = bytes.findIndex((_, i) => tag.every((b, j) => bytes[i + j] === b))
    expect(at).toBeGreaterThan(0)
    const out = new Uint8Array(bytes)
    new DataView(out.buffer).setUint16(at + 8, 151, true)
    await expect(decodeDicom(arrayBuffer(out))).rejects.toBeInstanceOf(DicomUnsupportedError)
  })
  it("rechaza un cuadro RLE dañado", async () => {
    const bytes = new Uint8Array(sample("rle.dcm"))
    // Sin los últimos 2000 bytes, el último segmento queda incompleto.
    const cut = bytes.slice(0, bytes.length - 2000)
    await expect(decodeDicom(arrayBuffer(cut))).rejects.toThrow()
  })
})
