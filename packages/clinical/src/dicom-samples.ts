/**
 * Muestras DICOM de DEMOSTRACIÓN, una por sintaxis de transferencia que lee
 * el visor: la misma periapical esquemática (no es de un paciente) guardada
 * con cada compresión. Los archivos viven en `samples/dicom/` (los genera
 * `samples/dicom/generate.py` con pydicom y GDCM) y se leen por su ruta de
 * paquete, `@odentia/clinical/samples/dicom/<file>`, desde Node (pruebas y
 * semilla).
 */
export interface DicomSample {
  file: string
  transferSyntax: string
  /** Nombre de la compresión, para la etiqueta de la semilla. */
  name: string
  /** Error máximo frente a `explicit-le.dcm`, en valores de 12 bits; 0 si es sin pérdida. */
  maxError: number
  frames: number
}

export const DICOM_SAMPLES: readonly DicomSample[] = [
  { file: "explicit-le.dcm", transferSyntax: "1.2.840.10008.1.2.1", name: "sin comprimir", maxError: 0, frames: 1 },
  { file: "explicit-be.dcm", transferSyntax: "1.2.840.10008.1.2.2", name: "Big Endian", maxError: 0, frames: 1 },
  { file: "rle.dcm", transferSyntax: "1.2.840.10008.1.2.5", name: "RLE", maxError: 0, frames: 1 },
  { file: "rle-multiframe.dcm", transferSyntax: "1.2.840.10008.1.2.5", name: "RLE, 3 cuadros", maxError: 0, frames: 3 },
  // 8 bits: el error se mide tras llevar la muestra a 12 bits (×4095/255).
  { file: "jpeg-baseline.dcm", transferSyntax: "1.2.840.10008.1.2.4.50", name: "JPEG de 8 bits", maxError: 160, frames: 1 },
  { file: "jpeg-extended-12bit.dcm", transferSyntax: "1.2.840.10008.1.2.4.51", name: "JPEG de 12 bits", maxError: 160, frames: 1 },
  { file: "jpeg-lossless.dcm", transferSyntax: "1.2.840.10008.1.2.4.57", name: "JPEG sin pérdida", maxError: 0, frames: 1 },
  { file: "jpeg-lossless-sv1.dcm", transferSyntax: "1.2.840.10008.1.2.4.70", name: "JPEG sin pérdida (SV1)", maxError: 0, frames: 1 },
  { file: "jpeg-ls-lossless.dcm", transferSyntax: "1.2.840.10008.1.2.4.80", name: "JPEG-LS", maxError: 0, frames: 1 },
  { file: "jpeg-ls-near-lossless.dcm", transferSyntax: "1.2.840.10008.1.2.4.81", name: "JPEG-LS casi sin pérdida", maxError: 2, frames: 1 },
  { file: "jpeg2000-lossless.dcm", transferSyntax: "1.2.840.10008.1.2.4.90", name: "JPEG 2000 sin pérdida", maxError: 0, frames: 1 },
  { file: "jpeg2000.dcm", transferSyntax: "1.2.840.10008.1.2.4.91", name: "JPEG 2000", maxError: 160, frames: 1 },
]
