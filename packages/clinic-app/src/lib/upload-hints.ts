import { type ImagingType, isRetiredPlanStatus } from "@odentia/clinical"
import { isIsoDate } from "@odentia/ui-patterns"
import { dicomHeader } from "./imaging-scan"
import type { EncounterDetail } from "./patients"

/**
 * Lo que un archivo ya trae al subirlo, leído en el navegador y sin ningún modelo: la
 * fecha de toma de un DICOM o de una foto, el tipo de imagen de un DICOM o el que dice
 * su nombre (o qué papel es), y si el nombre es el que deja la cámara (entonces el título
 * dice qué es).
 * Nunca adivina lo que no está escrito: las piezas no salen de la imagen, sino de la
 * atención desde la que se sube (`attentionTeeth`).
 */

/** De dónde salió lo que se llenó solo: de los datos del archivo, de su nombre o de su formato. */
export type HintSource = "archivo" | "nombre" | "formato"

export interface FileHints {
  /** El día de la toma (`yyyy-mm-dd`), nunca futuro; null si el archivo no trae uno que valga. */
  takenOn: string | null
  category: string | null
  imageType: string | null
  /** De dónde salieron la categoría y el tipo; null si no se sugiere ninguno. */
  from: HintSource | null
  /**
   * Una radiografía intraoral (DICOM IO, o «rx intraoral» en el nombre): su tipo es periapical,
   * interproximal u oclusal, y sin elegirlo el título dice «Radiografía intraoral».
   */
  intraoral: boolean
}

const NO_HINTS: FileHints = { takenOn: null, category: null, imageType: null, from: null, intraoral: false }

/** Sin tildes, en minúsculas y en palabras: «PeriapicalPieza46» → «periapical pieza 46». */
function words(text: string): string {
  const spaced = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/([a-z])(\d)|(\d)([a-z])/g, (_, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
  return ` ${spaced.split(/[^a-z0-9]+/).filter(Boolean).join(" ")} `
}

/** Una radiografía sin decir cuál: en un producto sin «radiografía simple», solo la categoría. */
const RADIOGRAPH_WORDS = ["rx", "radiografia", "radiograph", "xray", "x ray"]
export const INTRAORAL_TYPES: readonly string[] = ["periapical", "bitewing", "oclusal"]

/**
 * Las palabras del nombre (o de la descripción de un DICOM) que dicen claramente qué
 * imagen es. Solo valen los tipos que tiene el producto: «retinografía» no es nada en
 * una clínica dental.
 */
const TYPE_WORDS: ReadonlyArray<readonly [type: string, words: readonly string[]]> = [
  ["periapical", ["periapical", "periapicales"]],
  ["bitewing", ["bitewing", "bite wing", "interproximal", "aleta de mordida"]],
  ["oclusal", ["oclusal", "occlusal"]],
  ["panoramica", ["panoramica", "panoramic", "pano", "ortopantomografia", "opg"]],
  ["cefalometrica", ["cefalometrica", "cefalometria", "cephalometric", "ceph"]],
  ["foto_intraoral", ["intraoral"]],
  ["foto_extraoral", ["extraoral"]],
  ["radiografia_simple", RADIOGRAPH_WORDS],
  ["ecografia", ["ecografia", "ultrasonido"]],
  ["mamografia", ["mamografia"]],
  ["resonancia_magnetica", ["resonancia"]],
  ["retinografia", ["retinografia", "fondo de ojo"]],
  ["topografia_corneal", ["topografia corneal", "topografia"]],
  ["tomografia_optica", ["tomografia optica", "coherencia optica"]],
  ["campo_visual", ["campo visual", "campimetria"]],
]

const has = (said: string, phrases: readonly string[]) => phrases.some((phrase) => said.includes(` ${phrase} `))

/** ¿El producto nombra «radiografía» alguna de sus imágenes? (odentIA y latidIA sí; vistIA no.) */
const takesRadiographs = (types: readonly ImagingType[]) =>
  types.some((type) => type.category === "radiografia" && words(type.label).includes(" radiografia "))

/**
 * Qué imagen es según su nombre («Panorámica Rosa.jpg», «rx 46.png»). Solo una pista
 * clara: si dice dos tipos distintos, no se elige ninguno.
 */
export function nameHint(
  text: string,
  types: readonly ImagingType[],
  only?: readonly string[],
): { category: string; imageType: string | null; intraoral: boolean } | null {
  const said = words(text)
  const radiograph = has(said, RADIOGRAPH_WORDS) && takesRadiographs(types)
  const found = types.filter((type) => {
    if (only && !only.includes(type.value)) return false
    const listed = TYPE_WORDS.find(([value]) => value === type.value)?.[1]
    return listed ? has(said, listed) : false
  })
  const intraoral = (value: string) => INTRAORAL_TYPES.includes(value)
  // «rx intraoral»: una radiografía, no una foto; sin decir cuál de las intraorales.
  if (radiograph && found.some((type) => type.value === "foto_intraoral")) {
    const rest = found.filter((type) => type.category === "radiografia")
    if (rest.length === 1 && rest[0])
      return { category: "radiografia", imageType: rest[0].value, intraoral: intraoral(rest[0].value) }
    return types.some((type) => intraoral(type.value))
      ? { category: "radiografia", imageType: null, intraoral: true }
      : null
  }
  if (found.length === 1 && found[0])
    return { category: found[0].category, imageType: found[0].value, intraoral: intraoral(found[0].value) }
  if (found.length > 1) {
    const categories = new Set(found.map((type) => type.category))
    const [only1] = categories
    return categories.size === 1 && only1 ? { category: only1, imageType: null, intraoral: false } : null
  }
  return radiograph && !only ? { category: "radiografia", imageType: null, intraoral: false } : null
}

/**
 * El tipo según la modalidad del DICOM (0008,0060; PS3.3 C.7.3.1.1.1), en el orden en
 * que se prueba con los tipos del producto: vale el primero que tenga.
 */
const MODALITY_TYPES: Record<string, readonly string[]> = {
  PX: ["panoramica", "radiografia_simple"],
  CT: ["tomografia", "tomografia_computarizada"],
  // «CBCT» no es un término de DICOM (la de haz cónico se exporta como CT), pero hay equipos que lo escriben.
  CBCT: ["tomografia", "tomografia_computarizada"],
  IO: ["radiografia_simple"],
  DX: ["radiografia_simple"],
  CR: ["radiografia_simple"],
  MR: ["resonancia_magnetica"],
  US: ["ecografia"],
  MG: ["mamografia"],
  OP: ["retinografia"],
  OPT: ["tomografia_optica"],
  OPV: ["campo_visual"],
  OPM: ["topografia_corneal"],
}

/**
 * El día que dice una fecha DICOM (DA, AAAAMMDD; PS3.5 §6.2) o EXIF («AAAA:MM:DD»), ya
 * partida en año, mes y día, si es un día real y no futuro.
 */
function realDay(match: RegExpExecArray | null, today: string): string | null {
  if (!match) return null
  const iso = `${match[1]}-${match[2]}-${match[3]}`
  return isIsoDate(iso) && iso >= "1900-01-01" && iso <= today ? iso : null
}

/** El día de un valor DA de DICOM; también el formato viejo con puntos (ACR-NEMA, «2026.11.12»). */
export function dicomDay(value: string | null | undefined, today: string): string | null {
  const digits = (value ?? "").trim().replace(/\./g, "")
  return realDay(/^(\d{4})(\d{2})(\d{2})$/.exec(digits), today)
}

interface DicomTags {
  string(tag: string): string | undefined
}

const text = (ds: DicomTags, tag: string) => ds.string(tag)?.trim() || null

/**
 * La fecha y el tipo de un DICOM. La fecha, del estudio, de la adquisición o del
 * contenido, la primera que valga. El tipo, de la modalidad; la intraoral (IO) dice
 * si es periapical, interproximal u oclusal solo si su descripción o su nombre lo dicen.
 */
export function dicomHints(ds: DicomTags, name: string, types: readonly ImagingType[], today: string): FileHints {
  const takenOn =
    ["x00080020", "x00080022", "x00080023"].map((tag) => dicomDay(text(ds, tag), today)).find(Boolean) ?? null
  const modality = text(ds, "x00080060")?.toUpperCase() ?? ""
  // Lo que el equipo escribió del estudio, la serie y el protocolo, y el nombre del archivo.
  const described = [
    text(ds, "x00081030"),
    text(ds, "x0008103e"),
    text(ds, "x00181030"),
    text(ds, "x00204000"),
    name,
  ]
    .filter(Boolean)
    .join(" ")
  if (modality === "IO" && types.some((type) => INTRAORAL_TYPES.includes(type.value))) {
    const which = nameHint(described, types, INTRAORAL_TYPES)
    return { takenOn, category: "radiografia", imageType: which?.imageType ?? null, from: "archivo", intraoral: true }
  }
  const type = (MODALITY_TYPES[modality] ?? [])
    .map((value) => types.find((item) => item.value === value))
    .find(Boolean)
  if (type) return { takenOn, category: type.category, imageType: type.value, from: "archivo", intraoral: false }
  const hinted = nameHint(described, types)
  return hinted ? { takenOn, ...hinted, from: "archivo" } : { ...NO_HINTS, takenOn }
}

/**
 * DateTimeOriginal (0x9003) de la foto: el EXIF de un JPEG (APP1, «Exif\0\0» y una
 * estructura TIFF; CIPA DC-008), sin librería. Solo el día, como lo escribió la cámara.
 */
export function exifTakenOn(bytes: Uint8Array, today: string): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null
  let at = 2
  while (at + 4 <= bytes.length && view.getUint8(at) === 0xff) {
    const marker = view.getUint8(at + 1)
    // Inicio de la imagen comprimida o su fin: ya no hay más cabeceras.
    if (marker === 0xda || marker === 0xd9) return null
    const length = view.getUint16(at + 2)
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === "Exif\0\0")
      return tiffDateTimeOriginal(bytes.subarray(at + 10, at + 2 + length), today)
    at += 2 + length
  }
  return null
}

function tiffDateTimeOriginal(tiff: Uint8Array, today: string): string | null {
  if (tiff.length < 8) return null
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null
  const u16 = (offset: number) => (offset + 2 <= tiff.length ? view.getUint16(offset, little) : null)
  const u32 = (offset: number) => (offset + 4 <= tiff.length ? view.getUint32(offset, little) : null)
  /** El valor (o su posición) de una etiqueta en un IFD. */
  const find = (ifd: number, tag: number) => {
    const count = u16(ifd)
    if (count == null) return null
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12
      if (u16(entry) === tag) return { count: u32(entry + 4) ?? 0, value: u32(entry + 8) }
    }
    return null
  }
  const ifd0 = u32(4)
  const pointer = ifd0 == null ? null : find(ifd0, 0x8769)?.value
  const original = pointer == null ? null : find(pointer, 0x9003)
  if (!original?.value || original.count < 10) return null
  const said = String.fromCharCode(...tiff.subarray(original.value, original.value + 10))
  return realDay(/^(\d{4}):(\d{2}):(\d{2})$/.exec(said), today)
}

/** Las palabras del nombre que dicen qué papel es («Consentimiento firmado.pdf»): ganan al formato. */
const PAPER_WORDS: ReadonlyArray<readonly [category: string, words: readonly string[]]> = [
  ["consentimiento", ["consentimiento", "consentimientos", "consent"]],
  ["informe", ["informe", "informes", "hemograma", "laboratorio", "analisis", "resultado", "resultados"]],
]

/** La categoría de papel que dice el nombre, si dice una sola. */
export function paperHint(text: string): string | null {
  const said = words(text)
  const found = PAPER_WORDS.filter(([, listed]) => has(said, listed))
  return found.length === 1 && found[0] ? found[0][0] : null
}

/** Lo que trae un archivo ya leído (`readChosenFile`): no lo cambia ni lo sube. */
export async function readFileHints(file: File, types: readonly ImagingType[], today: string): Promise<FileHints> {
  const stem = file.name.replace(/\.[^.]+$/, "")
  try {
    if (file.type === "application/pdf") {
      // Lo que dice el nombre gana. Si no dice nada, un PDF que llega casi siempre es un
      // informe (de laboratorio, del centro de imágenes); si es otra cosa, se elige a mano.
      const named = paperHint(stem)
      return named
        ? { ...NO_HINTS, category: named, from: "nombre" }
        : { ...NO_HINTS, category: "informe", from: "formato" }
    }
    if (!file.type.startsWith("image/")) {
      // DICOM suele llegar sin tipo declarado: se reconoce por su contenido (el «DICM» de PS3.10).
      const ds = await dicomHeader(file)
      return ds ? dicomHints(ds, file.name, types, today) : NO_HINTS
    }
    // La foto de un papel («Consentimiento firmado.jpg») también dice qué es.
    const paper = paperHint(stem)
    const hinted = nameHint(stem, types) ?? (paper ? { category: paper, imageType: null, intraoral: false } : null)
    const takenOn =
      file.type === "image/jpeg"
        ? exifTakenOn(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()), today)
        : null
    return hinted ? { takenOn, ...hinted, from: "nombre" } : { ...NO_HINTS, takenOn }
  } catch {
    // Lo que no se pudo leer no se sugiere: la fila queda como hasta ahora.
    return NO_HINTS
  }
}

/**
 * Nombres que pone la cámara, el celular, la captura de pantalla, el escáner o el CD de
 * radiografías, sin decir nada de la imagen. Un nombre que puso la persona se respeta.
 */
const GENERIC_NAMES: readonly RegExp[] = [
  // IMG_1234, IMG-20261029-WA0003, IMG_E1234, MVIMG_…, PXL_2026…, DSC_0001, DSCN0001, DSCF0001, GOPR0001, P1010001
  /^(mv)?img[\W_]*[a-z]?\d/i,
  /^(pxl|dsc[fn]?|gopr|dcim)[\W_]*\d/i,
  /^p\d{7}$/i,
  // Captura de pantalla 2026-10-29 155127, Screenshot_2026…, Screen Shot 2020…
  /^(captura|screenshot|screen shot)/i,
  // WhatsApp Image 2026-10-29 at 15.51.27, Imagen de WhatsApp 2026-10-29 a las 15.51.27
  /^(whatsapp image|imagen de whatsapp)/i,
  // scan0001, Escaneo 2, CamScanner 10-29-2026 15.51
  /^(scan|escaneo|camscanner)[\W_]*\d/i,
  // image.png al pegar, image (2), Documento (3)
  /^(image|imagen|photo|foto|picture|document|documento|untitled|sin titulo|sin título)( ?\(\d+\))?$/i,
  // 20261029_155127 (Samsung y otros)
  /^\d{8}[\W_]\d{6}/,
  // Los del CD: IM000001, I0000001, 00000001, o el UID 1.2.840.113619.2.55…
  /^i(m)?[\W_]*\d+$/i,
  /^[\d.\-_ ]{6,}$/,
]

export function isGenericFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name
  const stem = base.replace(/\.[^.]+$/, "").trim()
  return GENERIC_NAMES.some((pattern) => pattern.test(stem))
}

/**
 * Las piezas que la atención trata o examina: las que se marcaron en ella, las de lo
 * que se hace o se indica hoy, las de sus diagnósticos y las de su odontograma. Lo
 * anulado no cuenta.
 */
export function attentionTeeth(detail: Pick<
  EncounterDetail,
  "teeth" | "procedures" | "diagnoses" | "plannedItems" | "indicatedItems" | "odontogramEntries"
>): number[] {
  const teeth = new Set<number>(detail.teeth)
  const add = (tooth: number | null | undefined) => {
    if (tooth != null) teeth.add(tooth)
  }
  for (const procedure of detail.procedures) if (!procedure.voidedAt) add(procedure.toothNumber)
  for (const diagnosis of detail.diagnoses) if (!diagnosis.voidedAt) add(diagnosis.toothNumber)
  for (const item of [...detail.plannedItems, ...detail.indicatedItems])
    if (!isRetiredPlanStatus(item.status)) add(item.toothNumber)
  for (const entry of detail.odontogramEntries ?? []) if (!entry.voidedAt) add(entry.toothNumber)
  return [...teeth].sort((a, b) => a - b)
}
