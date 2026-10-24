import * as dicomParser from "dicom-parser"

/**
 * Lee en el navegador lo que trae una carpeta de CD, un ZIP o una selección de
 * archivos y encuentra la tomografía (ADR 0055). Solo mira la cabecera de cada
 * DICOM (PS3.10): el resto del CD (el visor del centro de imágenes, sus
 * programas e imágenes de muestra y el DICOMDIR) no se sube.
 */

export interface SelectedFile {
  file: Blob
  /** Nombre o ruta dentro de la carpeta o del ZIP. */
  name: string
}

export interface ScannedDicom {
  file: Blob
  name: string
  size: number
  sopInstanceUid: string
  seriesInstanceUid: string
  studyInstanceUid: string
  modality: string | null
  patientName: string | null
  studyDate: string | null
  institution: string | null
  frames: number
  rows: number
  instanceNumber: number | null
  pixelSpacingMm: number | null
}

export interface StudyCandidate {
  studyInstanceUid: string
  patientName: string | null
  /** AAAAMMDD, como lo trae DICOM. */
  studyDate: string | null
  institution: string | null
  modality: string | null
  files: ScannedDicom[]
  totalBytes: number
  /** Cortes de la serie mayor, la que se reconstruye. */
  sliceCount: number
  voxelMm: number | null
  /** Archivos de la serie mayor en orden de corte, para la miniatura. */
  mainSeries: ScannedDicom[]
  /** ¿Es una tomografía (muchos cortes) o imágenes sueltas? */
  isVolume: boolean
}

export interface ScanResult {
  studies: StudyCandidate[]
  /** Archivos que no son DICOM de imagen (visor del CD, DICOMDIR, otros). */
  ignored: number
}

/** Media Storage Directory Storage (PS3.4 Anexo F): el índice del CD, no una imagen. */
const DICOMDIR_CLASS = "1.2.840.10008.1.3.10"
/** Cortes a partir de los cuales una serie se trata como volumen. */
const VOLUME_MIN_SLICES = 10

function text(ds: dicomParser.DataSet, tag: string): string | null {
  const value = ds.string(tag)?.trim()
  return value ? value : null
}

/**
 * Texto con el juego de caracteres del archivo (0008,0005; PS3.5 §6.1):
 * `ISO_IR 192` es UTF-8; sin indicarlo o con `ISO_IR 100`, Latin-1, que es como
 * lee dicom-parser. Los nombres con tilde o con ñ dependen de esto.
 */
function personText(ds: dicomParser.DataSet, tag: string): string | null {
  const element = ds.elements[tag]
  if (!element) return null
  const charset = text(ds, "x00080005") ?? ""
  if (!charset.includes("ISO_IR 192")) return text(ds, tag)
  const bytes = ds.byteArray.subarray(element.dataOffset, element.dataOffset + element.length)
  const value = new TextDecoder("utf-8").decode(bytes).replace(/[\0 ]+$/, "").trim()
  return value ? value : null
}

function isPart10(head: Uint8Array): boolean {
  return head.length >= 132 && head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d
}

async function headerOf(file: Blob): Promise<dicomParser.DataSet | null> {
  // Casi siempre la cabecera cabe en 256 KB; un CT de varios cuadros puede traer
  // varios MB de grupos funcionales, así que se amplía antes de rendirse.
  for (const limit of [256 * 1024, 8 * 1024 * 1024, file.size]) {
    const bytes = new Uint8Array(await file.slice(0, Math.min(limit, file.size)).arrayBuffer())
    if (!isPart10(bytes)) return null
    try {
      return dicomParser.parseDicom(bytes, { untilTag: "x7fe00010" })
    } catch {
      if (limit >= file.size) return null
    }
  }
  return null
}

async function scanOne(selected: SelectedFile): Promise<ScannedDicom | null> {
  if (selected.file.size < 132) return null
  const ds = await headerOf(selected.file)
  if (!ds) return null
  if (text(ds, "x00020002") === DICOMDIR_CLASS) return null
  const sop = text(ds, "x00080018")
  const series = text(ds, "x0020000e")
  const study = text(ds, "x0020000d")
  const rows = ds.uint16("x00280010") ?? 0
  if (!sop || !series || !study || !rows) return null
  return {
    file: selected.file,
    name: selected.name,
    size: selected.file.size,
    sopInstanceUid: sop,
    seriesInstanceUid: series,
    studyInstanceUid: study,
    modality: text(ds, "x00080060"),
    patientName: personText(ds, "x00100010"),
    studyDate: text(ds, "x00080020"),
    institution: personText(ds, "x00080080"),
    frames: Math.max(1, ds.intString("x00280008") ?? 1),
    rows,
    instanceNumber: ds.intString("x00200013") ?? null,
    pixelSpacingMm: ds.floatString("x00280030", 0) ?? null,
  }
}

/** Abre un ZIP sin cargarlo entero: cada archivo queda como Blob. */
async function unzip(zip: Blob, name: string): Promise<SelectedFile[]> {
  const { Unzip, UnzipInflate, UnzipPassThrough } = await import("fflate")
  const out: SelectedFile[] = []
  const pending: Promise<void>[] = []
  const unzipper = new Unzip((entry) => {
    if (entry.name.endsWith("/")) return
    const chunks: Uint8Array[] = []
    pending.push(
      new Promise((resolve, reject) => {
        entry.ondata = (error, chunk, final) => {
          if (error) return reject(error)
          chunks.push(chunk)
          if (final) {
            out.push({ file: new Blob(chunks as BlobPart[]), name: `${name}/${entry.name}` })
            resolve()
          }
        }
        entry.start()
      }),
    )
  })
  unzipper.register(UnzipInflate)
  unzipper.register(UnzipPassThrough)
  const reader = zip.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      unzipper.push(new Uint8Array(0), true)
      break
    }
    unzipper.push(value)
  }
  await Promise.all(pending)
  return out
}

function isZip(selected: SelectedFile): boolean {
  return /\.zip$/i.test(selected.name)
}

/**
 * Recorre la selección (también lo que haya dentro de un ZIP) y agrupa los
 * DICOM por estudio. `onProgress` recibe cuántos archivos van revisados.
 */
export async function scanSelection(
  selection: readonly SelectedFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResult> {
  const expanded: SelectedFile[] = []
  for (const item of selection) {
    if (isZip(item)) expanded.push(...(await unzip(item.file, item.name.replace(/\.zip$/i, ""))))
    else expanded.push(item)
  }
  const found: ScannedDicom[] = []
  let ignored = 0
  let done = 0
  // De a ocho: la lectura de cabeceras es sobre todo espera del disco o del CD.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(8, expanded.length) }, async () => {
      while (next < expanded.length) {
        const item = expanded[next++]!
        const scanned = await scanOne(item).catch(() => null)
        if (scanned) found.push(scanned)
        else ignored++
        done++
        onProgress?.(done, expanded.length)
      }
    }),
  )
  const byStudy = new Map<string, ScannedDicom[]>()
  const seen = new Set<string>()
  for (const file of found) {
    // El mismo archivo dos veces (copias en el CD) se sube una sola vez.
    if (seen.has(file.sopInstanceUid)) {
      ignored++
      continue
    }
    seen.add(file.sopInstanceUid)
    byStudy.set(file.studyInstanceUid, [...(byStudy.get(file.studyInstanceUid) ?? []), file])
  }
  const studies = [...byStudy.entries()].map(([studyInstanceUid, files]) => {
    const bySeries = new Map<string, ScannedDicom[]>()
    for (const file of files)
      bySeries.set(file.seriesInstanceUid, [...(bySeries.get(file.seriesInstanceUid) ?? []), file])
    const sliceTotal = (series: ScannedDicom[]) => series.reduce((n, f) => n + f.frames, 0)
    const main = [...bySeries.values()].sort((a, b) => sliceTotal(b) - sliceTotal(a))[0] ?? []
    const mainSeries = [...main].sort(
      (a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || a.name.localeCompare(b.name),
    )
    const first = mainSeries[0] ?? files[0]!
    const sliceCount = sliceTotal(mainSeries)
    return {
      studyInstanceUid,
      patientName: first.patientName,
      studyDate: first.studyDate,
      institution: first.institution,
      modality: first.modality,
      files,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      sliceCount,
      voxelMm: first.pixelSpacingMm,
      mainSeries,
      isVolume: sliceCount >= VOLUME_MIN_SLICES && first.rows >= 64,
    }
  })
  studies.sort((a, b) => b.totalBytes - a.totalBytes)
  return { studies, ignored }
}

/** Recorre lo que se soltó sobre la zona (también carpetas) con su ruta. */
export async function droppedFiles(transfer: DataTransfer): Promise<SelectedFile[]> {
  const entries = [...transfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry))
  if (!entries.length) return [...transfer.files].map((file) => ({ file, name: file.name }))
  const out: SelectedFile[] = []
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      out.push({ file, name: `${path}${entry.name}` })
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries entrega por tandas: se repite hasta que vuelva vacío.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      )
      if (!batch.length) break
      for (const child of batch) await walk(child, `${path}${entry.name}/`)
    }
  }
  for (const entry of entries) await walk(entry, "")
  return out
}

/** ¿Hay que revisar la selección en busca de una tomografía? */
export function mayHoldStudy(selection: readonly SelectedFile[], singleFileMaxBytes: number): boolean {
  if (selection.some((item) => isZip(item) || item.name.includes("/"))) return true
  const notPlain = selection.filter((item) => !/\.(jpe?g|png|webp|pdf)$/i.test(item.name))
  return notPlain.length > 1 || selection.some((item) => item.file.size > singleFileMaxBytes)
}

function words(value: string | null | undefined): string[] {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/)
    .filter((word) => word.length > 1)
}

/**
 * ¿El nombre que trae el archivo (PN de DICOM: «APELLIDOS^NOMBRES») es el de
 * esta persona? Solo sirve para avisar (decisión 6): nunca identifica a nadie.
 * Coincide si comparte al menos un apellido y, si el archivo trae nombres, uno
 * de ellos.
 */
export function dicomNameMatches(
  dicomName: string | null,
  person: { givenNames?: string | null; familyNames?: string | null; displayName: string },
): boolean | null {
  if (!dicomName || !words(dicomName).length) return null
  const [familyPart = "", givenPart = ""] = dicomName.split("^")
  const family = new Set(words(person.familyNames ?? person.displayName))
  const given = new Set(words(person.givenNames ?? person.displayName))
  const all = new Set([...family, ...given])
  if (!givenPart) return words(familyPart).filter((w) => all.has(w)).length >= 2
  return words(familyPart).some((w) => family.has(w)) && words(givenPart).some((w) => given.has(w))
}

/** «DIAZ ROJAS^CARMEN» → «DIAZ ROJAS, CARMEN», para mostrarlo tal cual viene. */
export function dicomNameText(dicomName: string): string {
  const [family = "", given = ""] = dicomName.split("^")
  return given ? `${family.trim()}, ${given.trim()}` : family.trim()
}
