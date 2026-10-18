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
  expect(byCode.get("DA08")).toMatchObject({ isCategory: true, isDental: true })
  expect(byCode.get("DA08.0")).toMatchObject({ title: "Caries dental", isCategory: false })
  // Lo único sin traducir en 2026-01 queda con su título oficial en inglés.
  expect(byCode.get("QA47.6")?.title).toBe("Multiple other than twins, born in hospital")
})

it("cada código que propone el odontograma en la CIE-11 existe y se puede registrar", () => {
  const icd11 = BUNDLED_DIAGNOSIS_LISTS.find((load) => load.system === "ICD-11")!
  const byCode = new Map(readDiagnosisList(icd11).rows.map((row) => [row.code, row]))
  for (const code of findingDiagnosisCodes("ICD-11")) {
    expect(byCode.get(code), code).toMatchObject({ isCategory: false })
  }
})
