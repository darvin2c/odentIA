import { encodeDemoCtSlice } from "@odentia/clinical"
import * as dicomParser from "dicom-parser"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { VolumeSource } from "./cbct-volume"
import {
  canReconstruct,
  readSeriesInfo,
  type SeriesInfo,
  seriesDetail,
  seriesInfoOf,
  seriesName,
  studySeries,
} from "./cbct-series"

afterEach(() => vi.unstubAllGlobals())

const source = (index: number, series: string): VolumeSource => ({
  index,
  url: `memoria/${index}`,
  sizeBytes: 1000,
  seriesInstanceUid: series,
})

const slice = (series: string, k: number, extra: { seriesDescription?: string; seriesNumber?: number; localizer?: boolean } = {}) =>
  encodeDemoCtSlice({
    ...extra,
    width: 8,
    height: 8,
    pixels: new Uint16Array(64),
    voxelMm: 1.25,
    position: [0, 0, k],
    instanceNumber: k + 1,
    studyUid: "2.25.9",
    seriesUid: series,
    frameOfReferenceUid: "2.25.9.3",
    sopUid: `2.25.9.4.${k + 1}`,
  })

const info = (patch: Partial<SeriesInfo>): SeriesInfo => ({
  description: null,
  number: null,
  thicknessMm: null,
  slices: 40,
  localizer: false,
  ...patch,
})

describe("series de la tomografía", () => {
  it("la mayor va primero, que es la que abre el visor, con sus archivos en orden", () => {
    const series = studySeries([source(3, "b"), source(0, "a"), source(2, "b"), source(1, "b")])
    expect(series.map((item) => item.uid)).toEqual(["b", "a"])
    expect(series[0]!.files.map((file) => file.index)).toEqual([1, 2, 3])
  })

  it("lee de la cabecera el nombre, el número, el grosor y si es el topograma", () => {
    const ds = dicomParser.parseDicom(slice("2.25.9.2", 0), { untilTag: "x7fe00010" })
    expect(seriesInfoOf(ds, 61)).toEqual({ description: null, number: null, thicknessMm: 1.25, slices: 61, localizer: false })
    const named = dicomParser.parseDicom(slice("2.25.9.2", 0, { seriesDescription: "Fase venosa", seriesNumber: 4 }), {
      untilTag: "x7fe00010",
    })
    expect(seriesInfoOf(named, 61)).toMatchObject({ description: "Fase venosa", number: 4 })
    const topogram = dicomParser.parseDicom(slice("2.25.9.5", 0, { localizer: true }), { untilTag: "x7fe00010" })
    expect(seriesInfoOf(topogram, 1)).toMatchObject({ localizer: true, slices: 1 })
  })

  it("pide solo el principio del primer archivo", async () => {
    const calls: (string | null)[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("Range"))
      return new Response(new Uint8Array(slice("2.25.9.2", 0)))
    })
    const [series] = studySeries([source(0, "2.25.9.2"), source(1, "2.25.9.2")])
    expect(await readSeriesInfo(series!)).toMatchObject({ thicknessMm: 1.25, slices: 2 })
    expect(calls).toEqual(["bytes=0-262143"])
  })

  it("el topograma y las series de pocos cortes se ven en la lista y no se arman", () => {
    const [series] = studySeries([source(0, "t")])
    expect(canReconstruct(info({ localizer: true, slices: 1 }))).toBe(false)
    expect(canReconstruct(info({ slices: 4 }))).toBe(false)
    expect(canReconstruct(info({ slices: 412 }))).toBe(true)
    // Sin cabecera todavía, se ofrece: no se adivina.
    expect(canReconstruct(null)).toBe(true)
    expect(seriesDetail(series!, info({ localizer: true, slices: 1 }), "es")).toBe("1 imagen · no se arma")
  })

  it("se nombra como la nombró el centro, o por su número", () => {
    const [series] = studySeries([source(0, "p")])
    expect(seriesName(info({ description: "Fase portal" }), 0)).toBe("Fase portal")
    expect(seriesName(info({ number: 4 }), 0)).toBe("Serie 4")
    expect(seriesName(null, 2)).toBe("Serie 3")
    expect(seriesDetail(series!, info({ thicknessMm: 1, slices: 412 }), "es")).toBe("1 mm · 412 cortes")
  })
})
