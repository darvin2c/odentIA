/**
 * Decodificadores de las compresiones DICOM (PS3.5 §8.2 y §A.4): JPEG
 * (baseline de 8 bits, extendido de 12 bits y sin pérdida), JPEG-LS y JPEG
 * 2000. Son los códecs WebAssembly que usa Cornerstone; cada uno se descarga
 * solo la primera vez que un archivo lo necesita.
 *
 * En el navegador se indica dónde está el `.wasm` empaquetado por Vite; en
 * Node (pruebas) el módulo lo busca junto a su propio archivo.
 */

export interface DecodedFrame {
  width: number
  height: number
  bitsPerSample: number
  components: number
  /** Muestras entrelazadas (RGBRGB…), una por elemento. */
  samples: Uint8Array | Uint16Array
}

interface WasmDecoder {
  getEncodedBuffer(length: number): Uint8Array
  decode(): void
  getFrameInfo(): {
    width: number
    height: number
    bitsPerSample: number
    componentCount: number
  }
  getDecodedBuffer(): Uint8Array | Uint16Array
  delete(): void
}

type WasmModule = Record<string, new () => WasmDecoder>
type WasmFactory = (options?: {
  locateFile?: (file: string) => string
  print?: (text: string) => void
}) => Promise<WasmModule>

function loader(load: () => Promise<{ default: WasmFactory }>, wasmUrl: () => Promise<{ default: string }>) {
  let ready: Promise<WasmModule> | null = null
  return () => {
    ready ??= (async () => {
      const factory = (await load()).default
      // OpenJPEG escribe su avance por la salida estándar; los errores siguen saliendo.
      const print = () => {}
      if (typeof window === "undefined") return factory({ print })
      const url = (await wasmUrl()).default
      return factory({ print, locateFile: (file) => (file.endsWith(".wasm") ? url : file) })
    })().catch((error: unknown) => {
      // Un fallo de red no deja el códec roto para el resto de la sesión.
      ready = null
      throw error
    })
    return ready
  }
}

const openJpeg = loader(
  () => import("@cornerstonejs/codec-openjpeg/decodewasmjs"),
  () => import("@cornerstonejs/codec-openjpeg/decodewasm?url"),
)
const charLs = loader(
  () => import("@cornerstonejs/codec-charls/decodewasmjs"),
  () => import("@cornerstonejs/codec-charls/decodewasm?url"),
)
const jpeg8 = loader(
  () => import("@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs"),
  () => import("@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm?url"),
)
const jpeg12 = loader(
  () => import("@cornerstonejs/codec-libjpeg-turbo-12bit/wasmjs"),
  // El paquete no exporta su `.wasm`: lo resuelve el alias de `vite.config.ts`.
  () => import("@cornerstonejs/codec-libjpeg-turbo-12bit/wasm?url"),
)

async function runWasm(module: Promise<WasmModule>, className: string, bytes: Uint8Array): Promise<DecodedFrame> {
  const Decoder = (await module)[className]
  if (!Decoder) throw new Error(`El códec no expone ${className}`)
  const decoder = new Decoder()
  try {
    decoder.getEncodedBuffer(bytes.length).set(bytes)
    decoder.decode()
    const info = decoder.getFrameInfo()
    const raw = decoder.getDecodedBuffer()
    // El búfer vive en la memoria del módulo: se copia antes de liberarlo.
    const wide = info.bitsPerSample > 8
    let samples: Uint8Array | Uint16Array
    if (!wide) samples = new Uint8Array(raw)
    else if (raw instanceof Uint16Array) samples = new Uint16Array(raw)
    else samples = new Uint16Array(raw.slice().buffer)
    return {
      width: info.width,
      height: info.height,
      bitsPerSample: info.bitsPerSample,
      components: info.componentCount,
      samples,
    }
  } finally {
    decoder.delete()
  }
}

export const decodeJpeg2000 = (bytes: Uint8Array) => runWasm(openJpeg(), "J2KDecoder", bytes)
export const decodeJpegLs = (bytes: Uint8Array) => runWasm(charLs(), "JpegLSDecoder", bytes)
export const decodeJpegBaseline = (bytes: Uint8Array) => runWasm(jpeg8(), "JPEGDecoder", bytes)
export const decodeJpegExtended12 = (bytes: Uint8Array) => runWasm(jpeg12(), "JPEGDecoder", bytes)

/** JPEG sin pérdida (Process 14, PS3.5 §A.4.1), con el decodificador en JS de rii-mango. */
export async function decodeJpegLossless(bytes: Uint8Array): Promise<DecodedFrame> {
  const { Decoder } = await import("jpeg-lossless-decoder-js")
  const decoder = new Decoder()
  const out = decoder.decode(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frame = decoder.frame
  return {
    width: frame.dimX,
    height: frame.dimY,
    bitsPerSample: frame.precision,
    components: decoder.numComp,
    samples: out instanceof Uint16Array ? new Uint16Array(out) : new Uint8Array(out),
  }
}
