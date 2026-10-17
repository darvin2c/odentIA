import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import {
  assertSha256,
  parseClaml,
  parseDelimited,
  parseDiagnosisFile,
  prepareDiagnosisRows,
} from "./diagnosis-import.js"

it("lee un CSV oficial con comillas dobles: el separador dentro de un campo no parte la fila", () => {
  const text =
    '﻿Código;Descripción\r\n"K02.1";"Caries de la dentina; con ""cavidad"""\r\n"S02.5";"Fractura de los dientes"\r\n'
  expect(parseDelimited(text)).toEqual([
    ["Código", "Descripción"],
    ["K02.1", 'Caries de la dentina; con "cavidad"'],
    ["S02.5", "Fractura de los dientes"],
  ])
  // El separador se decide una vez, con el encabezado: una coma del texto no cuenta.
  const rows = parseDiagnosisFile("code;description\nK00.6;Alteraciones de la erupción, dentaria\n")
  expect(rows).toEqual([
    { code: "K00.6", title: "Alteraciones de la erupción, dentaria", uri: null },
  ])
})

it("acepta códigos con † y * y códigos sin punto, y calcula categorías, lo dental y el texto sin tildes", () => {
  const rows = prepareDiagnosisRows(
    "ICD-10",
    parseDiagnosisFile(
      "code,description\nK02,Caries dental\nK021,Caries de la dentina\nB00.2†,Gingivoestomatitis herpética\nK93.8*,Trastornos de otros órganos digestivos\n",
    ),
  )
  expect(rows.map((row) => [row.code, row.isCategory, row.isDental])).toEqual([
    ["K02", true, true],
    ["K02.1", false, true],
    ["B00.2", false, true],
    ["K93.8", false, false],
  ])
  expect(rows[1]!.searchText).toBe("k02.1 k021 caries de la dentina")
  expect(
    prepareDiagnosisRows("ICD-10", [{ code: "K00.6", title: "Erupción", uri: null }])[0]!
      .searchText,
  ).toContain("erupcion")
})

it("rechaza un código que no tiene la forma de su lista y un código repetido con otro texto", () => {
  expect(() =>
    prepareDiagnosisRows("ICD-10", [{ code: "DA08.0", title: "Caries", uri: null }]),
  ).toThrow(/Código inválido/)
  expect(() =>
    prepareDiagnosisRows("ICD-10", [
      { code: "K02.1", title: "Caries de la dentina", uri: null },
      { code: "K021", title: "Otra cosa", uri: null },
    ]),
  ).toThrow(/dos veces/)
})

it("lee la tabulación de la CIE-11 de la OMS: solo categorías, sin los guiones de profundidad y con su URI", () => {
  const tsv = [
    "Foundation URI\tLinearization (release) URI\tCode\tBlockId\tTitle\tClassKind",
    "\thttp://id.who.int/icd/release/11/2024-01/mms/1\t\tBlockX\tEnfermedades de la boca\tblock",
    "\thttp://id.who.int/icd/release/11/2024-01/mms/2\tDA08.0\t\t- - Caries dental\tcategory",
  ].join("\n")
  expect(prepareDiagnosisRows("ICD-11", parseDiagnosisFile(tsv))).toEqual([
    expect.objectContaining({
      code: "DA08.0",
      title: "Caries dental",
      uri: "http://id.who.int/icd/release/11/2024-01/mms/2",
      isDental: true,
    }),
  ])
})

it("lee ClaML: cada categoría con su rúbrica preferida en español", () => {
  const xml = `<?xml version="1.0"?><ClaML><Class code="K02" kind="block"><Rubric kind="preferred"><Label xml:lang="es">Bloque</Label></Rubric></Class>
  <Class code="K02.1" kind="category"><Rubric kind="inclusion"><Label xml:lang="es">Otra</Label></Rubric><Rubric kind="preferred"><Label xml:lang="en">Caries of dentine</Label><Label xml:lang="es">Caries de la dentina &amp; esmalte</Label></Rubric></Class></ClaML>`
  expect(parseClaml(xml)).toEqual([
    { code: "K02.1", title: "Caries de la dentina & esmalte", uri: null },
  ])
})

it("verifica el SHA-256 antes de cargar: un archivo distinto del publicado no entra", () => {
  const bytes = new TextEncoder().encode("code,description\nK02.1,Caries de la dentina\n")
  const good = createHash("sha256").update(bytes).digest("hex")
  expect(assertSha256(bytes, good.toUpperCase())).toBe(good)
  expect(() => assertSha256(bytes, "0".repeat(64))).toThrow(/no coincide con el publicado/)
  expect(() => assertSha256(bytes, undefined)).toThrow(/Falta el SHA-256/)
})
