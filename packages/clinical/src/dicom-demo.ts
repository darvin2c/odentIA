/**
 * Codificador DICOM mínimo (Part 10, Explicit VR Little Endian) para generar
 * archivos de DEMOSTRACIÓN y pruebas: radiografía intraoral monocroma de 16
 * bits con espaciado de píxel del detector. No es un exportador clínico: no
 * se usa con datos de pacientes reales.
 */

const EXPLICIT_LE = "1.2.840.10008.1.2.1"
/** Digital Intra-Oral X-Ray Image Storage – For Presentation (PS3.4). */
const INTRAORAL_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.1.3"

type Value = { vr: string; bytes: Uint8Array }

const LONG_VRS = new Set(["OB", "OW", "SQ", "UN", "UT"])

function text(vr: string, value: string): Value {
  let s = value
  if (s.length % 2 === 1) s += vr === "UI" ? "\0" : " "
  return { vr, bytes: new TextEncoder().encode(s) }
}

function us(value: number): Value {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, value, true)
  return { vr: "US", bytes: b }
}

function element(group: number, el: number, value: Value): Uint8Array {
  const long = LONG_VRS.has(value.vr)
  const head = new Uint8Array(long ? 12 : 8)
  const view = new DataView(head.buffer)
  view.setUint16(0, group, true)
  view.setUint16(2, el, true)
  head[4] = value.vr.charCodeAt(0)
  head[5] = value.vr.charCodeAt(1)
  if (long) view.setUint32(8, value.bytes.byteLength, true)
  else view.setUint16(6, value.bytes.byteLength, true)
  const out = new Uint8Array(head.byteLength + value.bytes.byteLength)
  out.set(head)
  out.set(value.bytes, head.byteLength)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

export interface DemoDicomInput {
  width: number
  height: number
  /** Valores de 0 a 4095 (12 bits almacenados), fila por fila. */
  pixels: Uint16Array
  /** Espaciado del detector en mm (fila, columna). */
  pixelSpacingMm?: [number, number]
  studyDate?: string
  uid?: string
}

export function encodeDemoDicom(input: DemoDicomInput): Uint8Array {
  const uid = input.uid ?? `2.25.${Date.now()}${Math.floor(Math.random() * 1e6)}`
  const [rowMm, colMm] = input.pixelSpacingMm ?? [0.04, 0.04]
  const pixelBytes = new Uint8Array(input.pixels.buffer, input.pixels.byteOffset, input.pixels.byteLength)
  const metaBody = concat([
    element(0x0002, 0x0001, { vr: "OB", bytes: new Uint8Array([0, 1]) }),
    element(0x0002, 0x0002, text("UI", INTRAORAL_SOP_CLASS)),
    element(0x0002, 0x0003, text("UI", uid)),
    element(0x0002, 0x0010, text("UI", EXPLICIT_LE)),
  ])
  const groupLength = new Uint8Array(4)
  new DataView(groupLength.buffer).setUint32(0, metaBody.byteLength, true)
  const meta = concat([element(0x0002, 0x0000, { vr: "UL", bytes: groupLength }), metaBody])
  const dataset = concat([
    element(0x0008, 0x0016, text("UI", INTRAORAL_SOP_CLASS)),
    element(0x0008, 0x0018, text("UI", uid)),
    element(0x0008, 0x0020, text("DA", input.studyDate ?? "20261008")),
    element(0x0008, 0x0060, text("CS", "IO")),
    element(0x0008, 0x0070, text("LO", "DEMO Odentia32")),
    element(0x0010, 0x0010, text("PN", "DEMO^PACIENTE")),
    element(0x0018, 0x1164, text("DS", `${rowMm}\\${colMm}`)),
    element(0x0028, 0x0002, us(1)),
    element(0x0028, 0x0004, text("CS", "MONOCHROME2")),
    element(0x0028, 0x0010, us(input.height)),
    element(0x0028, 0x0011, us(input.width)),
    element(0x0028, 0x0100, us(16)),
    element(0x0028, 0x0101, us(12)),
    element(0x0028, 0x0102, us(11)),
    element(0x0028, 0x0103, us(0)),
    element(0x0028, 0x1050, text("DS", "2048")),
    element(0x0028, 0x1051, text("DS", "4096")),
    element(0x7fe0, 0x0010, { vr: "OW", bytes: pixelBytes }),
  ])
  const preamble = new Uint8Array(132)
  preamble.set(new TextEncoder().encode("DICM"), 128)
  return concat([preamble, meta, dataset])
}
