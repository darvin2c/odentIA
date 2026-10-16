import { afterEach, describe, expect, it } from "vitest"
import { setFormatRegion } from "../locale.js"
import {
  ageText,
  clinicDateLocale,
  likelyLocaleOf,
  readWrittenDate,
  writeDate,
  writtenDateFormat,
  writtenDateProblemText,
} from "./written-date.js"

const TODAY = "2026-10-16"

describe("fecha escrita", () => {
  afterEach(() => setFormatRegion({ locale: "es-PE", timeZone: "America/Lima" }))

  it("una página que solo sabe el país de la clínica escribe en el orden probable de ese país", () => {
    expect(likelyLocaleOf("PE")).toBe("es-PE")
    expect(likelyLocaleOf("us")).toBe("en-US")
    expect(likelyLocaleOf("")).toBeUndefined()
    setFormatRegion({})
    expect(clinicDateLocale("PE")).toBe("es-PE")
    expect(writtenDateFormat(clinicDateLocale("US")).placeholder).toBe("mm/dd/aaaa")
    // Con el formato de la clínica fijado, manda ese.
    setFormatRegion({ locale: "es-CL" })
    expect(clinicDateLocale("US")).toBe("es-CL")
  })

  it("toma el orden y el separador del formato de la clínica, sin tabla de países", () => {
    expect(writtenDateFormat("es-PE")).toMatchObject({ order: ["day", "month", "year"], placeholder: "dd/mm/aaaa" })
    expect(writtenDateFormat("en-US")).toMatchObject({ order: ["month", "day", "year"], placeholder: "mm/dd/aaaa" })
    expect(writtenDateFormat("sv-SE")).toMatchObject({ order: ["year", "month", "day"], placeholder: "aaaa-mm-dd" })
    expect(writtenDateFormat("de-DE").separator).toBe(".")
  })

  it("muestra en el orden de la clínica lo que se guarda en ISO 8601", () => {
    expect(writeDate("1995-07-30", writtenDateFormat("es-PE"))).toBe("30/07/1995")
    expect(writeDate("1995-07-30", writtenDateFormat("en-US"))).toBe("07/30/1995")
    expect(writeDate("", writtenDateFormat("es-PE"))).toBe("")
  })

  it("lee lo escrito en el orden de cada formato y lo devuelve en ISO", () => {
    expect(readWrittenDate("30/07/1995", TODAY, writtenDateFormat("es-PE")).iso).toBe("1995-07-30")
    expect(readWrittenDate("07/30/1995", TODAY, writtenDateFormat("en-US")).iso).toBe("1995-07-30")
    expect(readWrittenDate("1995-07-30", TODAY, writtenDateFormat("sv-SE")).iso).toBe("1995-07-30")
  })

  it("dice qué arreglar: a medias, un día que no existe, una fecha futura o demasiado antigua", () => {
    const peru = writtenDateFormat("es-PE")
    const problem = (text: string) => readWrittenDate(text, TODAY, peru).problem
    expect(readWrittenDate("", TODAY, peru)).toEqual({ iso: null, empty: true, problem: null })
    expect(problem("30/07/19")).toEqual({ kind: "incompleta" })
    expect(problem("30/13/1995")).toEqual({ kind: "mes" })
    expect(problem("00/07/1995")).toEqual({ kind: "dia" })
    expect(problem("31/02/1995")).toEqual({ kind: "no-existe", days: 28 })
    expect(problem("29/02/2024")).toBeNull()
    expect(problem("17/10/2026")).toEqual({ kind: "futura" })
    expect(problem("16/10/2026")).toBeNull()
    expect(problem("01/01/1890")).toMatchObject({ kind: "antigua" })
    expect(writtenDateProblemText({ kind: "no-existe", days: 28 }, peru)).toBe("Ese mes tiene 28 días: revisa el día")
    expect(writtenDateProblemText({ kind: "incompleta" }, peru)).toBe("Escribe día, mes y año: dd/mm/aaaa")
  })

  it("dice la edad cumplida, también la de un bebé", () => {
    expect(ageText("1995-07-30", TODAY)).toBe("31 años")
    expect(ageText("1995-10-17", TODAY)).toBe("30 años")
    expect(ageText("2025-10-16", TODAY)).toBe("1 año")
    expect(ageText("2026-02-10", TODAY)).toBe("8 meses")
    expect(ageText("2026-10-04", TODAY)).toBe("12 días")
    expect(ageText(TODAY, TODAY)).toBe("Nació hoy")
    expect(ageText("2026-10-17", TODAY)).toBe("")
  })
})
