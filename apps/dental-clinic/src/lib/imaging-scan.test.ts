import { encodeDemoCtSlice, encodeDemoDicom } from "@odentia/clinical"
import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { dicomNameMatches, mayHoldStudy, type SelectedFile, scanSelection } from "./imaging-scan"

const STUDY = "2.25.55001"

function ctSlice(k: number, study = STUDY): Uint8Array {
  return encodeDemoCtSlice({
    width: 64,
    height: 64,
    pixels: new Uint16Array(64 * 64).fill(1000 + k),
    voxelMm: 0.3,
    position: [-10, -10, k * 0.3],
    instanceNumber: k + 1,
    studyUid: study,
    seriesUid: `${study}.2`,
    frameOfReferenceUid: `${study}.3`,
    sopUid: `${study}.4.${k + 1}`,
    patientName: "DIAZ ROJAS^CARMEN",
    institution: "Centro de Imágenes San Borja",
  })
}

/** Una carpeta de CD: 12 cortes, su visor (un .exe y una imagen) y otra radiografía suelta. */
function cdFolder(): SelectedFile[] {
  const slices = Array.from({ length: 12 }, (_, k) => ({
    // Desordenados, como suelen venir en el CD.
    file: new Blob([ctSlice(11 - k) as BlobPart]),
    name: `CD/DICOM/IMG${String(11 - k).padStart(4, "0")}`,
  }))
  const viewer = { file: new Blob([new Uint8Array(4000) as BlobPart]), name: "CD/Viewer/viewer.exe" }
  const logo = { file: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0, 0]) as BlobPart]), name: "CD/Viewer/logo.jpg" }
  const loose = {
    file: new Blob([encodeDemoDicom({ width: 8, height: 8, pixels: new Uint16Array(64) }) as BlobPart]),
    name: "CD/DICOM/RX0001",
  }
  return [...slices, viewer, logo, loose]
}

describe("lectura de la carpeta de una tomografía", () => {
  it("encuentra la tomografía, ordena sus cortes y no sube el visor del CD", async () => {
    const result = await scanSelection(cdFolder())
    const [study] = result.studies
    expect(study).toMatchObject({
      studyInstanceUid: STUDY,
      patientName: "DIAZ ROJAS^CARMEN",
      institution: "Centro de Imágenes San Borja",
      modality: "CT",
      sliceCount: 12,
      voxelMm: 0.3,
      isVolume: true,
    })
    expect(study!.mainSeries.map((file) => file.instanceNumber)).toEqual(
      Array.from({ length: 12 }, (_, k) => k + 1),
    )
    // El visor no es DICOM y la radiografía suelta no trae a qué estudio pertenece
    // (sin StudyInstanceUID no se puede agrupar): ninguno de los tres se sube.
    expect(result.studies).toHaveLength(1)
    expect(result.ignored).toBe(3)
  })

  it("abre un ZIP sin cargarlo entero", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 10 }, (_, k) => [`DICOM/IMG${k}.dcm`, ctSlice(k, "2.25.55002")]),
    )
    const zip = zipSync(entries, { level: 1 })
    const result = await scanSelection([{ file: new Blob([zip as BlobPart]), name: "tomografia.zip" }])
    expect(result.studies[0]).toMatchObject({ studyInstanceUid: "2.25.55002", sliceCount: 10 })
  })

  it("el mismo archivo dos veces se sube una sola vez", async () => {
    const twice = [ctSlice(0), ctSlice(0), ...Array.from({ length: 10 }, (_, k) => ctSlice(k + 1))].map(
      (bytes, i) => ({ file: new Blob([bytes as BlobPart]), name: `copia/${i}` }),
    )
    const result = await scanSelection(twice)
    expect(result.studies[0]!.files).toHaveLength(11)
    expect(result.ignored).toBe(1)
  })

  it("solo revisa lo que puede traer una tomografía", () => {
    const photo = { file: new Blob([new Uint8Array(10) as BlobPart]), name: "foto.jpg" }
    expect(mayHoldStudy([photo], 10)).toBe(false)
    expect(mayHoldStudy([{ ...photo, name: "CD/foto.jpg" }], 10)).toBe(true)
    expect(mayHoldStudy([{ ...photo, name: "estudio.zip" }], 10)).toBe(true)
  })
})

describe("aviso cuando el archivo trae otro nombre (decisión 6)", () => {
  const carmen = { displayName: "Carmen Díaz Rojas", givenNames: "Carmen", familyNames: "Díaz Rojas" }
  it("coincide sin importar tildes, mayúsculas ni el orden de DICOM", () => {
    expect(dicomNameMatches("DIAZ ROJAS^CARMEN", carmen)).toBe(true)
    expect(dicomNameMatches("diaz^carmen rosa", carmen)).toBe(true)
  })
  it("otro nombre no coincide y un archivo sin nombre no dice nada", () => {
    expect(dicomNameMatches("QUISPE^ROSA", carmen)).toBe(false)
    expect(dicomNameMatches("DIAZ^ROSA", carmen)).toBe(false)
    expect(dicomNameMatches("", carmen)).toBeNull()
    expect(dicomNameMatches(null, carmen)).toBeNull()
  })
})
