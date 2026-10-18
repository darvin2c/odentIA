// Los módulos de los códecs DICOM no publican tipos (o los declaran sin
// incluirlos): solo se tipa lo que usa `lib/dicom-codecs.ts`.

type CornerstoneCodecFactory = (options?: {
  locateFile?: (file: string) => string
  print?: (text: string) => void
}) => Promise<Record<string, new () => never>>

declare module "@cornerstonejs/codec-openjpeg/decodewasmjs" {
  const factory: CornerstoneCodecFactory
  export default factory
}
declare module "@cornerstonejs/codec-charls/decodewasmjs" {
  const factory: CornerstoneCodecFactory
  export default factory
}
declare module "@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs" {
  const factory: CornerstoneCodecFactory
  export default factory
}
declare module "@cornerstonejs/codec-libjpeg-turbo-12bit/wasmjs" {
  const factory: CornerstoneCodecFactory
  export default factory
}

declare module "jpeg-lossless-decoder-js" {
  export class Decoder {
    frame: { dimX: number; dimY: number; precision: number }
    numComp: number
    decode(buffer: ArrayBufferLike, offset: number, length: number): Uint8Array | Uint16Array
  }
}
