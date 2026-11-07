import * as dicomParser from "dicom-parser"
import type { VolumeSource } from "./cbct-volume"
import { DICOM_PARSE_OPTIONS } from "./dicom"
import { VOLUME_MIN_SLICES } from "./imaging-scan"

/**
 * Las series de una tomografía (ADR 0151). Un CD médico trae varias (sin
 * contraste, fases, reconstrucciones gruesas, el topograma); una CBCT, casi
 * siempre una. El visor abre la mayor, como siempre, y deja elegir otra. Lo que
 * se dice de cada una se lee de la cabecera de su primer archivo: no se guarda
 * nada aparte.
 */

export interface StudySeries {
  uid: string
  files: VolumeSource[]
}

/** Las series en el orden en que se ofrecen; la primera es la mayor, la que abre el visor. */
export function studySeries(sources: readonly VolumeSource[]): StudySeries[] {
  const bySeries = new Map<string, VolumeSource[]>()
  for (const source of sources) {
    const list = bySeries.get(source.seriesInstanceUid)
    if (list) list.push(source)
    else bySeries.set(source.seriesInstanceUid, [source])
  }
  return [...bySeries.entries()]
    .map(([uid, files]) => ({ uid, files: [...files].sort((a, b) => a.index - b.index) }))
    .sort((a, b) => b.files.length - a.files.length)
}

export interface SeriesInfo {
  /** Series Description (0008,103E), tal como la escribió el centro. */
  description: string | null
  /** Series Number (0020,0011). */
  number: number | null
  /** Slice Thickness (0018,0050), en mm. */
  thicknessMm: number | null
  /** Cortes: los archivos o, en un CT de varios cuadros, sus cuadros. */
  slices: number
  /** El topograma (Image Type con LOCALIZER, PS3.3 C.8.2.1.1.1): una imagen plana de guía. */
  localizer: boolean
}


/** Lo que se lee de una cabecera DICOM ya abierta. */
export function seriesInfoOf(ds: dicomParser.DataSet, files: number): SeriesInfo {
  const description = ds.string("x0008103e")?.trim() || null
  const frames = Math.max(1, ds.intString("x00280008") ?? 1)
  const thickness = ds.floatString("x00180050")
  return {
    description,
    number: ds.intString("x00200011") ?? null,
    thicknessMm: thickness !== undefined && Number.isFinite(thickness) && thickness > 0 ? thickness : null,
    slices: files === 1 ? frames : files,
    localizer: (ds.string("x00080008") ?? "").toUpperCase().includes("LOCALIZER"),
  }
}

/**
 * La cabecera del primer archivo de la serie. Pide solo el principio del
 * archivo (Range): la cabecera cabe ahí, y un CT de varios cuadros puede pesar
 * cientos de MB. Si no se puede leer, la serie se ofrece igual, con su número.
 */
export async function readSeriesInfo(series: StudySeries, signal?: AbortSignal): Promise<SeriesInfo | null> {
  const first = series.files[0]
  if (!first) return null
  const response = await fetch(first.url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` }, signal })
  if (!response.ok) return null
  const bytes = await firstBytes(response)
  try {
    const ds = dicomParser.parseDicom(bytes, { ...DICOM_PARSE_OPTIONS, untilTag: "x7fe00010" })
    return seriesInfoOf(ds, series.files.length)
  } catch (error) {
    // La cabecera no cupo (un CT de varios cuadros): dicom-parser deja lo que alcanzó a leer.
    const partial = (error as { dataSet?: dicomParser.DataSet } | null)?.dataSet
    return partial ? seriesInfoOf(partial, series.files.length) : null
  }
}

/** Lo que se lee de cada serie: la cabecera cabe ahí casi siempre. */
const HEAD_BYTES = 256 * 1024

/**
 * Los primeros bytes de la respuesta. Si el almacenamiento ignora el Range y manda
 * el archivo entero (200), se deja de leer al llegar a ellos.
 */
async function firstBytes(response: Response): Promise<Uint8Array> {
  if (response.status === 206 || !response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const out = new Uint8Array(HEAD_BYTES)
  let length = 0
  while (length < HEAD_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    const take = Math.min(value.length, HEAD_BYTES - length)
    out.set(value.subarray(0, take), length)
    length += take
  }
  await reader.cancel().catch(() => undefined)
  return out.subarray(0, length)
}

/** ¿Se puede armar como volumen? El topograma y las series de pocos cortes, no. */
export function canReconstruct(info: SeriesInfo | null | undefined): boolean {
  if (!info) return true
  return !info.localizer && info.slices >= VOLUME_MIN_SLICES
}

const mm = (value: number, locale: string) =>
  `${value.toLocaleString(locale, { maximumFractionDigits: 2 })} mm`

/** «Fase portal», o «Serie 4» si el centro no la nombró. */
export function seriesName(info: SeriesInfo | null | undefined, position: number): string {
  return info?.description ?? `Serie ${info?.number ?? position + 1}`
}

/** «1 mm · 412 cortes», o «1 imagen · no se arma» en un topograma. */
export function seriesDetail(series: StudySeries, info: SeriesInfo | null | undefined, locale: string): string {
  const slices = info?.slices ?? series.files.length
  const count = `${slices.toLocaleString(locale)} ${slices === 1 ? "imagen" : "cortes"}`
  if (!canReconstruct(info)) return `${count} · no se arma`
  return info?.thicknessMm ? `${mm(info.thicknessMm, locale)} · ${count}` : count
}
