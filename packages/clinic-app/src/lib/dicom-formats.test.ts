import { createRequire } from "node:module"
import * as dicomParser from "dicom-parser"
import { deflateSync } from "fflate"
import { describe, expect, it } from "vitest"
import { decodeDicom, measurableSpacing, measureSpacing, spacingIssueText } from "./dicom"

const require = createRequire(import.meta.url)

/** Un DICOM mínimo (Part 10) para las pruebas, sin datos de pacientes. */
const EXPLICIT_LE = "1.2.840.10008.1.2.1"
const DEFLATE = "1.2.840.10008.1.2.1.99"
const HTJ2K_LOSSLESS = "1.2.840.10008.1.2.4.201"
const LONG = new Set(["OB", "OW", "UN", "UT", "SQ"])

function bytesOf(vr: string, value: string): Uint8Array {
  const raw = new TextEncoder().encode(value)
  if (raw.length % 2 === 0) return raw
  const out = new Uint8Array(raw.length + 1)
  out.set(raw)
  out[raw.length] = vr === "UI" ? 0 : 0x20
  return out
}

function us(value: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, value, true)
  return b
}

function element(group: number, el: number, vr: string, value: Uint8Array): Uint8Array {
  const long = LONG.has(vr)
  const head = new Uint8Array(long ? 12 : 8)
  const view = new DataView(head.buffer)
  view.setUint16(0, group, true)
  view.setUint16(2, el, true)
  head[4] = vr.charCodeAt(0)
  head[5] = vr.charCodeAt(1)
  if (long) view.setUint32(8, value.length, true)
  else view.setUint16(6, value.length, true)
  return concat([head, value])
}

function item(group: number, el: number, value: Uint8Array): Uint8Array {
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint16(0, group, true)
  view.setUint16(2, el, true)
  view.setUint32(4, value.length, true)
  return concat([head, value])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

interface Build {
  syntax?: string
  modality: string
  imagerSpacing?: string
  pixelSpacing?: string
  magnification?: string
  width?: number
  height?: number
  pixels?: Uint16Array
  /** Píxeles ya comprimidos (un cuadro), encapsulados como dice PS3.5 §A.4. */
  encapsulated?: Uint8Array
}

function build(input: Build): ArrayBuffer {
  const syntax = input.syntax ?? EXPLICIT_LE
  const width = input.width ?? 4
  const height = input.height ?? 3
  const pixels = input.pixels ?? Uint16Array.from({ length: width * height }, (_, i) => i * 100)
  const metaBody = concat([
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0002, "UI", bytesOf("UI", "1.2.840.10008.5.1.4.1.1.1.1")),
    element(0x0002, 0x0003, "UI", bytesOf("UI", "2.25.1")),
    element(0x0002, 0x0010, "UI", bytesOf("UI", syntax)),
  ])
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, metaBody.length, true)
  const meta = concat([element(0x0002, 0x0000, "UL", length), metaBody])
  const pixelData = input.encapsulated
    ? concat([
        element(0x7fe0, 0x0010, "OB", new Uint8Array(0)).subarray(0, 8),
        new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        item(0xfffe, 0xe000, new Uint8Array(0)),
        item(
          0xfffe,
          0xe000,
          input.encapsulated.length % 2
            ? concat([input.encapsulated, new Uint8Array(1)])
            : input.encapsulated,
        ),
        item(0xfffe, 0xe0dd, new Uint8Array(0)),
      ])
    : element(
        0x7fe0,
        0x0010,
        "OW",
        new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      )
  const dataset = concat([
    element(0x0008, 0x0016, "UI", bytesOf("UI", "1.2.840.10008.5.1.4.1.1.1.1")),
    element(0x0008, 0x0018, "UI", bytesOf("UI", "2.25.1")),
    element(0x0008, 0x0060, "CS", bytesOf("CS", input.modality)),
    ...(input.magnification
      ? [element(0x0018, 0x1114, "DS", bytesOf("DS", input.magnification))]
      : []),
    ...(input.imagerSpacing
      ? [element(0x0018, 0x1164, "DS", bytesOf("DS", input.imagerSpacing))]
      : []),
    element(0x0028, 0x0002, "US", us(1)),
    element(0x0028, 0x0004, "CS", bytesOf("CS", "MONOCHROME2")),
    element(0x0028, 0x0010, "US", us(height)),
    element(0x0028, 0x0011, "US", us(width)),
    ...(input.pixelSpacing
      ? [element(0x0028, 0x0030, "DS", bytesOf("DS", input.pixelSpacing))]
      : []),
    element(0x0028, 0x0100, "US", us(16)),
    element(0x0028, 0x0101, "US", us(16)),
    element(0x0028, 0x0102, "US", us(15)),
    element(0x0028, 0x0103, "US", us(0)),
    pixelData,
  ])
  const preamble = new Uint8Array(132)
  preamble.set(new TextEncoder().encode("DICM"), 128)
  const body = syntax === DEFLATE ? deflateSync(dataset) : dataset
  const out = concat([preamble, meta, body])
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

function spacingOf(input: Build) {
  return measureSpacing(dicomParser.parseDicom(new Uint8Array(build(input))))
}

describe("medir en mm solo con una escala que vale", () => {
  it("la intraoral mide con el espaciado del detector: el sensor va pegado al diente", () => {
    expect(spacingOf({ modality: "IO", imagerSpacing: "0.02\\0.02" })).toMatchObject({
      spacing: [0.02, 0.02],
      issue: null,
    })
  })
  it("la cefalométrica sin su ampliación no mide: en mm saldría más grande de lo real", () => {
    expect(spacingOf({ modality: "DX", imagerSpacing: "0.1\\0.1" })).toMatchObject({
      spacing: null,
      issue: "ampliada",
    })
  })
  it("con la ampliación del archivo, el espaciado del detector se corrige", () => {
    const { spacing, issue } = spacingOf({
      modality: "DX",
      imagerSpacing: "0.11\\0.11",
      magnification: "1.1",
    })
    expect(issue).toBeNull()
    expect(spacing?.[0]).toBeCloseTo(0.1)
    expect(spacing?.[1]).toBeCloseTo(0.1)
  })
  it("Pixel Spacing ya está en el paciente", () => {
    expect(
      spacingOf({ modality: "DX", pixelSpacing: "0.1\\0.12", imagerSpacing: "0.13\\0.13" }),
    ).toMatchObject({
      spacing: [0.1, 0.12],
      issue: null,
    })
  })
  it("la panorámica nunca mide en mm: su ampliación cambia de un punto a otro", () => {
    expect(spacingOf({ modality: "PX", pixelSpacing: "0.1\\0.1" })).toMatchObject({
      spacing: null,
      issue: "panoramica",
    })
  })
  it("sin espaciado no mide, y cada caso dice la salida", async () => {
    expect(spacingOf({ modality: "IO" })).toMatchObject({ spacing: null, issue: "sin_espaciado" })
    expect(spacingIssueText("panoramica")).toMatch(/periapical o en la tomografía/)
    expect(spacingIssueText("ampliada")).toMatch(/más grande de lo real/)
    expect(spacingIssueText("sin_espaciado")).toMatch(/equipo de rayos X/)
    const image = await decodeDicom(build({ modality: "PX", pixelSpacing: "0.1\\0.1" }))
    expect(image.pixelSpacing).toBeNull()
    expect(image.spacingIssue).toBe("panoramica")
  })
})

describe("lo que la ficha dice que es también decide si se mide", () => {
  it("una panorámica exportada como radiografía común no mide en mm", async () => {
    const image = await decodeDicom(build({ modality: "DX", pixelSpacing: "0.1\\0.1" }))
    expect(image.pixelSpacing).toEqual([0.1, 0.1])
    expect(measurableSpacing(image, "panoramica")).toEqual({ spacing: null, issue: "panoramica" })
    expect(measurableSpacing(image, "periapical").spacing).toEqual([0.1, 0.1])
  })
  it("una cefalométrica con la escala del sensor copiada no mide; con la ampliación, sí", async () => {
    const copied = await decodeDicom(build({ modality: "DX", pixelSpacing: "0.1\\0.1" }))
    expect(measurableSpacing(copied, "cefalometrica")).toEqual({ spacing: null, issue: "ampliada" })
    const corrected = await decodeDicom(
      build({ modality: "DX", imagerSpacing: "0.11\\0.11", magnification: "1.1" }),
    )
    expect(measurableSpacing(corrected, "cefalometrica").spacing?.[0]).toBeCloseTo(0.1)
  })
  it("una foto dice que no trae escala, sin pedir un archivo que no tiene", () => {
    expect(spacingIssueText("foto")).toBe(
      "Una foto no trae escala: se puede mirar, no medir en mm.",
    )
  })
})

describe("compresiones de los equipos nuevos", () => {
  it("lee el conjunto de datos comprimido con Deflate igual que el nativo", async () => {
    const native = await decodeDicom(build({ modality: "IO", imagerSpacing: "0.02\\0.02" }))
    const deflated = await decodeDicom(
      build({ syntax: DEFLATE, modality: "IO", imagerSpacing: "0.02\\0.02" }),
    )
    expect(deflated.meta.transferSyntax).toBe(DEFLATE)
    expect(Array.from(deflated.values ?? [])).toEqual(Array.from(native.values ?? []))
    expect(deflated.pixelSpacing).toEqual([0.02, 0.02])
  })
  it("lee HTJ2K sin pérdida con los mismos valores", async () => {
    const width = 16
    const height = 12
    const pixels = Uint16Array.from({ length: width * height }, (_, i) => (i * 37) % 4096)
    const factory = require("@cornerstonejs/codec-openjph/wasmjs") as (o: object) => Promise<
      Record<
        string,
        new () => {
          getDecodedBuffer(info: object): Uint8Array
          encode(): void
          getEncodedBuffer(): Uint8Array
          delete(): void
        }
      >
    >
    const codec = await factory({ print: () => {} })
    const Encoder = codec.HTJ2KEncoder!
    const encoder = new Encoder()
    const input = encoder.getDecodedBuffer({
      width,
      height,
      bitsPerSample: 16,
      componentCount: 1,
      isSigned: false,
      isUsingColorTransform: false,
    })
    input.set(new Uint8Array(pixels.buffer))
    encoder.encode()
    const encoded = new Uint8Array(encoder.getEncodedBuffer())
    encoder.delete()
    const image = await decodeDicom(
      build({
        syntax: HTJ2K_LOSSLESS,
        modality: "IO",
        imagerSpacing: "0.02\\0.02",
        width,
        height,
        encapsulated: encoded,
      }),
    )
    expect(image.meta.transferSyntax).toBe(HTJ2K_LOSSLESS)
    expect(Array.from(image.values ?? [])).toEqual(Array.from(pixels))
  })
})
