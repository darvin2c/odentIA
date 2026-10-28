import { findingDiagnosisCodes } from "@odentia/clinical"
import { expect, it } from "vitest"
import { BUNDLED_DIAGNOSIS_LISTS, readDiagnosisList } from "./diagnosis-catalog.js"

// Sin base de datos: el archivo oficial incluido se lee como en el despliegue.
it("la CIE-11 incluida es la de la OMS (SHA-256 del .zip) y trae los capítulos 01 a 25 completos", () => {
  const icd11 = BUNDLED_DIAGNOSIS_LISTS.find((load) => load.system === "ICD-11")!
  const { sha, rows } = readDiagnosisList(icd11)
  expect(sha).toBe(icd11.sha256)
  expect(rows).toHaveLength(17_255)
  // Sin extensiones (X), funcionamiento (V) ni medicina tradicional (capítulo 26, S).
  expect(rows.filter((row) => /^[XVS]/.test(row.code))).toEqual([])
  // Cada código con su URI de la OMS (licencia, cláusula 1.2.3).
  expect(rows.every((row) => row.uri?.startsWith("http://id.who.int/icd/release/11/mms/"))).toBe(true)
  const byCode = new Map(rows.map((row) => [row.code, row]))
  expect(byCode.get("DA08")).toMatchObject({ isCategory: true })
  expect(byCode.get("DA08.0")).toMatchObject({ title: "Caries dental", isCategory: false })
  // Lo único sin traducir en 2026-01 queda con su título oficial en inglés.
  expect(byCode.get("QA47.6")?.title).toBe("Multiple other than twins, born in hospital")
})

it("la CIE-10 del MINSA incluida es la hoja oficial (SHA-256 del .xlsx) y viene completa", () => {
  const minsa = BUNDLED_DIAGNOSIS_LISTS.find((load) => load.system === "ICD-10-PE")!
  const { sha, rows } = readDiagnosisList(minsa)
  expect(sha).toBe(minsa.sha256)
  // Verificada el 2026-10-28: 2 051 de 3 caracteres, 12 634 de 4, 329 de 5 y 23 de 6 (ADR 0103).
  expect(rows).toHaveLength(15_037)
  const byLength = (n: number) => rows.filter((row) => row.code.replace(".", "").length === n).length
  expect([byLength(3), byLength(4), byLength(5), byLength(6)]).toEqual([2_051, 12_634, 329, 23])
  // Ningún subcódigo sin su categoría de tres caracteres.
  const codes = new Set(rows.map((row) => row.code))
  expect(rows.filter((row) => row.code.length > 3 && !codes.has(row.code.slice(0, 3)))).toEqual([])
  const byCode = new Map(rows.map((row) => [row.code, row]))
  expect(byCode.get("K02")).toMatchObject({ title: "CARIES DENTAL", isCategory: true })
  expect(byCode.get("K02.1")).toMatchObject({ title: "CARIES DE LA DENTINA", isCategory: false })
  // La categoría sin subdivisiones va con su X, y los códigos propios del MINSA tienen seis caracteres.
  expect(byCode.get("I10.X")).toMatchObject({ isCategory: false })
  expect(byCode.get("Z30.051")).toMatchObject({ isCategory: false })
  expect(byCode.get("P07.11")?.title).toBe("RECIEN NACIDO DE MUY BAJO PESO AL NACER (< 1500 GRAMOS)")
})

it("cada código que propone el odontograma en la CIE-10 del MINSA existe y se puede registrar", () => {
  const minsa = BUNDLED_DIAGNOSIS_LISTS.find((load) => load.system === "ICD-10-PE")!
  const byCode = new Map(readDiagnosisList(minsa).rows.map((row) => [row.code, row]))
  for (const code of findingDiagnosisCodes("ICD-10-PE")) {
    expect(byCode.get(code), code).toMatchObject({ isCategory: false })
  }
})

it("cada código que propone el odontograma en la CIE-11 existe y se puede registrar", () => {
  const icd11 = BUNDLED_DIAGNOSIS_LISTS.find((load) => load.system === "ICD-11")!
  const byCode = new Map(readDiagnosisList(icd11).rows.map((row) => [row.code, row]))
  for (const code of findingDiagnosisCodes("ICD-11")) {
    expect(byCode.get(code), code).toMatchObject({ isCategory: false })
  }
})
