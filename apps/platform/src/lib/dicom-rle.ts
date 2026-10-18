/**
 * Descompresión RLE de DICOM (PS3.5 Anexo G): el cuadro trae una cabecera de
 * 64 bytes con el número de segmentos y sus desplazamientos, y cada segmento
 * es un plano de bytes (del más al menos significativo, muestra por muestra)
 * comprimido con PackBits. Un cuadro que no cuadra con la imagen lanza error.
 */
export function decodeRleFrame(
  frame: Uint8Array,
  format: { rows: number; cols: number; samples: number; bitsAllocated: number },
): Uint16Array {
  const count = format.rows * format.cols
  const bytesPerSample = format.bitsAllocated / 8
  const header = new DataView(frame.buffer, frame.byteOffset, Math.min(64, frame.byteLength))
  if (frame.byteLength < 64) throw new Error("El cuadro RLE no tiene cabecera")
  const segments = header.getUint32(0, true)
  if (segments !== format.samples * bytesPerSample || segments > 15) {
    throw new Error("El número de segmentos RLE no coincide con la imagen")
  }
  const out = new Uint16Array(count * format.samples)
  for (let k = 0; k < segments; k++) {
    const start = header.getUint32(4 + k * 4, true)
    const end = k + 1 < segments ? header.getUint32(4 + (k + 1) * 4, true) : frame.byteLength
    if (start < 64 || end > frame.byteLength || end < start) throw new Error("Segmento RLE fuera del cuadro")
    const sample = Math.floor(k / bytesPerSample)
    const shift = 8 * (bytesPerSample - 1 - (k % bytesPerSample))
    let pos = start
    let written = 0
    const put = (byte: number) => {
      const at = written * format.samples + sample
      out[at] = (out[at] ?? 0) | (byte << shift)
      written++
    }
    while (pos < end && written < count) {
      const n = (frame[pos++] ?? 0) << 24 >> 24
      if (n >= 0) {
        for (let i = 0; i <= n && pos < end && written < count; i++) put(frame[pos++] ?? 0)
      } else if (n !== -128) {
        const byte = frame[pos++] ?? 0
        for (let i = 0; i < 1 - n && written < count; i++) put(byte)
      }
    }
    if (written < count) throw new Error("El cuadro RLE está incompleto")
  }
  return out
}
