import { DENTAL_IMAGING_TYPES, encodeDemoDicom, type ImagingType } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import {
  attentionTeeth,
  composeTitle,
  exifTakenOn,
  isGenericFileName,
  nameHint,
  placesWords,
  readFileHints,
} from "./upload-hints"

/**
 * «Subir imágenes o documentos» se llena con lo que el archivo ya trae (16 nov): la fecha
 * de un DICOM o de una foto, el tipo de un DICOM o el que dice su nombre, el título si el
 * nombre es el de la cámara y las piezas de la atención. Sin ningún modelo.
 */

const TODAY = "2026-11-15"

// Los de latidIA y vistIA (`@odentia/medical`, `@odentia/optical`), que este paquete no importa.
const MEDICAL_IMAGING_TYPES: ImagingType[] = [
  { value: "radiografia_simple", label: "Radiografía", category: "radiografia" },
  { value: "ecografia", label: "Ecografía", category: "radiografia" },
  { value: "tomografia_computarizada", label: "Tomografía computarizada", category: "radiografia" },
  { value: "foto_clinica", label: "Foto clínica", category: "foto_clinica" },
]
const OPTICAL_IMAGING_TYPES: ImagingType[] = [
  { value: "retinografia", label: "Retinografía (fondo de ojo)", category: "radiografia" },
  { value: "campo_visual", label: "Campo visual", category: "radiografia" },
  { value: "foto_segmento_anterior", label: "Foto del ojo", category: "foto_clinica" },
]

function dicom(name: string, options: { studyDate?: string | null; modality?: string } = {}): File {
  const bytes = encodeDemoDicom({ width: 4, height: 2, pixels: new Uint16Array(8), ...options })
  return new File([bytes as BlobPart], name, { type: "application/dicom" })
}

/** Un JPEG mínimo con su EXIF: SOI, APP1 «Exif» con DateTimeOriginal y EOI. */
function jpegWithExif(dateTime: string | null, order: "II" | "MM" = "II"): Uint8Array {
  const little = order === "II"
  const ascii = new TextEncoder().encode(`${dateTime ?? ""}\0`)
  const ifd0 = 8
  const exifIfd = ifd0 + 18
  const value = exifIfd + 18
  const tiff = new Uint8Array(value + ascii.length)
  const view = new DataView(tiff.buffer)
  tiff.set(little ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a])
  view.setUint32(4, ifd0, little)
  view.setUint16(ifd0, 1, little)
  view.setUint16(ifd0 + 2, 0x8769, little)
  view.setUint16(ifd0 + 4, 4, little)
  view.setUint32(ifd0 + 6, 1, little)
  view.setUint32(ifd0 + 10, exifIfd, little)
  view.setUint16(exifIfd, dateTime ? 1 : 0, little)
  view.setUint16(exifIfd + 2, 0x9003, little)
  view.setUint16(exifIfd + 4, 2, little)
  view.setUint32(exifIfd + 6, ascii.length, little)
  view.setUint32(exifIfd + 10, value, little)
  tiff.set(ascii, value)
  const header = new TextEncoder().encode("Exif\0\0")
  const length = 2 + header.length + tiff.length
  return new Uint8Array([
    0xff, 0xd8,
    // APP0 (JFIF) antes del EXIF, como lo dejan muchas cámaras.
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xe1, length >> 8, length & 0xff, ...header, ...tiff,
    0xff, 0xd9,
  ])
}

const jpeg = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name, { type: "image/jpeg" })

describe("la fecha de toma que trae el archivo", () => {
  it("un DICOM con fecha: la del estudio", async () => {
    const hints = await readFileHints(dicom("IM000001.dcm", { studyDate: "20261112" }), DENTAL_IMAGING_TYPES, TODAY)
    expect(hints.takenOn).toBe("2026-11-12")
  })

  it("un DICOM sin fecha, o con una futura, no propone ninguna: queda «La de subida»", async () => {
    expect((await readFileHints(dicom("IM000001.dcm", { studyDate: null }), DENTAL_IMAGING_TYPES, TODAY)).takenOn).toBeNull()
    expect((await readFileHints(dicom("IM000002.dcm", { studyDate: "20261120" }), DENTAL_IMAGING_TYPES, TODAY)).takenOn).toBeNull()
    expect((await readFileHints(dicom("IM000003.dcm", { studyDate: "20260230" }), DENTAL_IMAGING_TYPES, TODAY)).takenOn).toBeNull()
  })

  it("una foto con EXIF: su DateTimeOriginal, en los dos órdenes de bytes", async () => {
    const hints = await readFileHints(jpeg("IMG_4821.jpg", jpegWithExif("2026:11:14 10:24:05")), DENTAL_IMAGING_TYPES, TODAY)
    expect(hints.takenOn).toBe("2026-11-14")
    expect(exifTakenOn(jpegWithExif("2025:03:02 08:00:00", "MM"), TODAY)).toBe("2025-03-02")
  })

  it("una foto sin EXIF, con la fecha vacía o futura, no propone ninguna", async () => {
    expect(exifTakenOn(jpegWithExif(null), TODAY)).toBeNull()
    expect(exifTakenOn(jpegWithExif("0000:00:00 00:00:00"), TODAY)).toBeNull()
    expect(exifTakenOn(jpegWithExif("2027:01:01 00:00:00"), TODAY)).toBeNull()
    expect(exifTakenOn(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), TODAY)).toBeNull()
  })
})

describe("la categoría y el tipo", () => {
  it("un DICOM intraoral es una radiografía; periapical o interproximal solo si lo dice", async () => {
    const plain = await readFileHints(dicom("IM000001.dcm"), DENTAL_IMAGING_TYPES, TODAY)
    expect(plain).toMatchObject({ category: "radiografia", imageType: null, intraoral: true, from: "archivo" })
    const bitewing = await readFileHints(dicom("Bitewing derecha.dcm"), DENTAL_IMAGING_TYPES, TODAY)
    expect(bitewing).toMatchObject({ category: "radiografia", imageType: "bitewing", intraoral: false })
  })

  it("panorámica (PX) y tomografía (CT, o CBCT si el equipo lo escribe); otra modalidad, sin elegir", async () => {
    const at = async (modality: string) =>
      readFileHints(dicom("IM000001.dcm", { modality }), DENTAL_IMAGING_TYPES, TODAY)
    expect(await at("PX")).toMatchObject({ category: "radiografia", imageType: "panoramica" })
    expect(await at("CT")).toMatchObject({ category: "radiografia", imageType: "tomografia" })
    expect(await at("CBCT")).toMatchObject({ category: "radiografia", imageType: "tomografia" })
    expect(await at("SR")).toMatchObject({ category: null, imageType: null, from: null })
  })

  it("en latidIA la tomografía es la computarizada", async () => {
    const hints = await readFileHints(dicom("IM000001.dcm", { modality: "CT" }), MEDICAL_IMAGING_TYPES, TODAY)
    expect(hints).toMatchObject({ category: "radiografia", imageType: "tomografia_computarizada", intraoral: false })
  })

  it("un PDF es un informe, sugerido por su formato", async () => {
    const pdf = new File(["%PDF-1.7"], "Hemograma Rosa Quispe.pdf", { type: "application/pdf" })
    expect(await readFileHints(pdf, DENTAL_IMAGING_TYPES, TODAY)).toMatchObject({
      category: "informe",
      imageType: null,
      from: "formato",
    })
  })

  it("una imagen común queda sin elegir, salvo una pista clara en su nombre", async () => {
    const plain = await readFileHints(jpeg("IMG_4821.jpg", jpegWithExif(null)), DENTAL_IMAGING_TYPES, TODAY)
    expect(plain).toMatchObject({ category: null, imageType: null, from: null })
    const pano = await readFileHints(jpeg("Panorámica Rosa.jpg", jpegWithExif(null)), DENTAL_IMAGING_TYPES, TODAY)
    expect(pano).toMatchObject({ category: "radiografia", imageType: "panoramica", from: "nombre" })
    expect(nameHint("periapical_46", DENTAL_IMAGING_TYPES)).toMatchObject({ imageType: "periapical" })
    expect(nameHint("PeriapicalPieza46", DENTAL_IMAGING_TYPES)).toMatchObject({ imageType: "periapical" })
    expect(nameHint("foto intraoral frente", DENTAL_IMAGING_TYPES)).toMatchObject({ imageType: "foto_intraoral" })
    // «rx» dice radiografía, sin decir cuál; con «intraoral», tampoco es una foto.
    expect(nameHint("RX 36", DENTAL_IMAGING_TYPES)).toEqual({ category: "radiografia", imageType: null, intraoral: false })
    expect(nameHint("rx intraoral 36", DENTAL_IMAGING_TYPES)).toEqual({ category: "radiografia", imageType: null, intraoral: true })
    // Dos tipos distintos: no se elige ninguno; «proxy» no es «rx».
    expect(nameHint("panoramica y periapical", DENTAL_IMAGING_TYPES)).toEqual({ category: "radiografia", imageType: null, intraoral: false })
    expect(nameHint("foto intraoral y panoramica", DENTAL_IMAGING_TYPES)).toBeNull()
    expect(nameHint("proxy", DENTAL_IMAGING_TYPES)).toBeNull()
  })

  it("cada producto solo con sus tipos", () => {
    expect(nameHint("rx torax", MEDICAL_IMAGING_TYPES)).toMatchObject({ imageType: "radiografia_simple" })
    expect(nameHint("retinografia OD", OPTICAL_IMAGING_TYPES)).toMatchObject({ imageType: "retinografia" })
    expect(nameHint("rx 36", OPTICAL_IMAGING_TYPES)).toBeNull()
    expect(nameHint("retinografia", DENTAL_IMAGING_TYPES)).toBeNull()
  })
})

describe("el título", () => {
  it("un nombre de cámara o de captura se reemplaza", () => {
    for (const name of [
      "Captura de pantalla 2026-10-29 155127.png",
      "Screenshot_20261029-155127_WhatsApp.jpg",
      "IMG_4821.jpg",
      "IMG-20261029-WA0003.jpg",
      "IMG_E1234.JPG",
      "DSC_0001.JPG",
      "DSCN0001.jpg",
      "PXL_20261029_155127123.jpg",
      "WhatsApp Image 2026-10-29 at 15.51.27.jpeg",
      "Imagen de WhatsApp 2026-10-29 a las 15.51.27_9f0c.jpg",
      "20261029_155127.jpg",
      "image.png",
      "scan0001.pdf",
      "IM000001.dcm",
      "1.2.840.113619.2.55.3.dcm",
    ])
      expect(isGenericFileName(name), name).toBe(true)
  })

  it("un nombre que puso la persona se respeta", () => {
    for (const name of [
      "Hemograma Rosa Quispe.pdf",
      "Periapical 46 control.jpg",
      "Foto 46.jpg",
      "46.jpg",
      "Imagen de la sonrisa.png",
      "Informe tomografía.pdf",
    ])
      expect(isGenericFileName(name), name).toBe(false)
  })

  it("dice qué es, dónde y cuándo", () => {
    const site = { placeLabel: "Pieza", placesLabel: "Piezas" }
    expect(composeTitle("Radiografía periapical", placesWords([46], site), "15 nov")).toBe(
      "Radiografía periapical · pieza 46 · 15 nov",
    )
    expect(composeTitle("Foto intraoral", placesWords([], site), "15 nov")).toBe("Foto intraoral · 15 nov")
    expect(placesWords([36, 46], site)).toBe("piezas 36 y 46")
    expect(placesWords([16, 26, 36], site)).toBe("piezas 16, 26 y 36")
    expect(placesWords([16, 26, 36, 46], site)).toBe("4 piezas")
    expect(placesWords([46], null)).toBeNull()
  })
})

describe("las piezas de la atención", () => {
  const empty = {
    teeth: [] as number[],
    procedures: [],
    diagnoses: [],
    plannedItems: [],
    indicatedItems: [],
    odontogramEntries: [],
  }

  it("las que trata o examina, sin lo anulado ni lo que ya no va", () => {
    const teeth = attentionTeeth({
      ...empty,
      teeth: [21],
      procedures: [
        { toothNumber: 46, voidedAt: null },
        { toothNumber: 11, voidedAt: "2026-11-15T10:00:00Z" },
      ] as never,
      diagnoses: [{ toothNumber: 36, voidedAt: null }, { toothNumber: null, voidedAt: null }] as never,
      plannedItems: [{ toothNumber: 46, status: "en_curso" }] as never,
      indicatedItems: [
        { toothNumber: 47, status: "pendiente" },
        { toothNumber: 18, status: "cancelado" },
      ] as never,
      odontogramEntries: [{ toothNumber: 26, voidedAt: null }] as never,
    })
    expect(teeth).toEqual([21, 26, 36, 46, 47])
  })

  it("una atención sin piezas no propone ninguna", () => {
    expect(attentionTeeth(empty)).toEqual([])
  })
})
