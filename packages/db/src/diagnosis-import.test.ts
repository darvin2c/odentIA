import { createHash } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import { expect, it } from "vitest"
import {
  assertSha256,
  diagnosisFileText,
  parseClaml,
  parseDelimited,
  parseDiagnosisFile,
  prepareDiagnosisRows,
  readZipEntries,
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
  expect(rows.map((row) => [row.code, row.isCategory])).toEqual([
    ["K02", true],
    ["K02.1", false],
    ["B00.2", false],
    ["K93.8", false],
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
    }),
  ])
})

it("de la CIE-11 carga los capítulos 01 a 25: sin extensiones, funcionamiento ni medicina tradicional; sin traducción, el título oficial en inglés", () => {
  const tsv = [
    "Linearization URI\tCode\tTitleEN\tTitle\tClassKind\tChapterNo",
    "u1\tDA08.0\t- - Dental caries\t- - Caries dental\tcategory\t13",
    "u2\tQA47.6\t- - Multiple other than twins, born in hospital\t\tcategory\t24",
    "u3\tXS8H\tNone\tNinguno\tcategory\tX",
    "u4\tVA00\tLearning\tAprendizaje\tcategory\tV",
    "u5\tSK01\tMigraine disorder (TM2)\t\tcategory\t26",
  ].join("\n")
  expect(parseDiagnosisFile(tsv)).toEqual([
    { code: "DA08.0", title: "Caries dental", uri: "u1" },
    { code: "QA47.6", title: "Multiple other than twins, born in hospital", uri: "u2" },
  ])
})

/** Un .zip mínimo (APPNOTE): un archivo guardado y otro con deflate. */
function zipOf(files: Record<string, { text: string; deflate: boolean }>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, { text, deflate }] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8")
    const data = deflate ? deflateRawSync(raw) : raw
    const nameBytes = Buffer.from(name, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

it("lee el .zip tal como se descarga: su único archivo de datos, sin el readme", () => {
  const bytes = zipOf({
    "readme.txt": { text: "Code: ICD-11 code", deflate: false },
    "SimpleTabulation-ICD-11-MMS-es.txt": {
      text: "Code\tTitle\tClassKind\nDA08.0\tCaries dental\tcategory\n",
      deflate: true,
    },
  })
  expect(readZipEntries(bytes).get("readme.txt")?.toString("utf8")).toBe("Code: ICD-11 code")
  expect(parseDiagnosisFile(diagnosisFileText(bytes))).toEqual([
    { code: "DA08.0", title: "Caries dental", uri: null },
  ])
  // Un archivo que no es .zip se lee tal cual.
  expect(diagnosisFileText(new TextEncoder().encode("code,description\n"))).toBe(
    "code,description\n",
  )
  const two = zipOf({
    "a.csv": { text: "code,description\n", deflate: false },
    "b.csv": { text: "code,description\n", deflate: false },
  })
  expect(() => diagnosisFileText(two)).toThrow(/un solo archivo de datos/)
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
