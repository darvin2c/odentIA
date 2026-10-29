import { describe, expect, it } from "vitest"
import { checkClinicImportPlan, type ClinicImportPerson, type ClinicImportPlan } from "./clinic-import-plan.js"
import {
  clinicImportMapSchema,
  detectDelimiter,
  parseCsv,
  prepareClinicImport,
  profileColumns,
  readDate,
  readPhone,
  tidyName,
} from "./clinic-import-prepare.js"

const TODAY = "2026-10-29"
const SHA = "a".repeat(64)

function person(key: string, demographics: Partial<ClinicImportPerson["demographics"]>, extra: Partial<ClinicImportPerson> = {}): ClinicImportPerson {
  const displayName = demographics.displayName ?? [demographics.givenNames, demographics.familyName].filter(Boolean).join(" ")
  return { key, patient: true, demographics: { ...demographics, displayName }, ...extra }
}

function plan(people: ClinicImportPerson[]): ClinicImportPlan {
  return { version: 1, countryCode: "PE", sources: [{ name: "pacientes.csv", sha256: SHA }], people, omitted: [] }
}

const csv = (text: string) => parseCsv(text, detectDelimiter(text))

describe("leer el archivo de la clínica", () => {
  it("separa celdas con comillas, saltos de línea y BOM, deduce el separador y conserva las filas vacías", () => {
    const text = '﻿Nombre;Nota\n"Pérez; Ana";"dijo ""hola""\nsegunda línea"\r\n\n;\n'
    expect(detectDelimiter(text)).toBe(";")
    expect(parseCsv(text, ";")).toEqual([["Nombre", "Nota"], ["Pérez; Ana", 'dijo "hola"\nsegunda línea'], [""], ["", ""]])
  })

  it("muestra la forma de cada columna sin los datos de las personas, aunque arriba haya un título", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `Persona ${i};0${i}/04/1985;${i % 2 ? "M" : "F"}`)
    const profile = profileColumns(csv(["Reporte de pacientes;;", "Fecha: 28/10/2026;;", "Nombre;Nacimiento;Sexo", ...rows].join("\n")))
    expect(profile).toMatchObject({ headerRow: 3, above: [1, 1], rows: 10 })
    const [name, birth, sex] = profile.columns
    expect(name).not.toHaveProperty("values")
    expect(birth!.shapes[0]).toEqual(["99/99/9999", 10])
    expect(sex!.values).toEqual([["F", 5], ["M", 5]])
  })

  it("lee fechas sin adivinar el siglo ni días que no existen", () => {
    expect(readDate("3/4/1985", "DD/MM/YYYY")).toEqual({ value: "1985-04-03" })
    expect(readDate("04/03/1985", "MM/DD/YYYY")).toEqual({ value: "1985-04-03" })
    expect(readDate("31155", "DD/MM/YYYY")).toEqual({ value: "1985-04-18" })
    expect(readDate("31155.4375", "DD/MM/YYYY")).toEqual({ value: "1985-04-18" })
    expect(readDate("12/12/85", "DD/MM/YYYY")).toHaveProperty("error")
    expect(readDate("31/02/1970", "DD/MM/YYYY")).toHaveProperty("error")
  })

  it("toma el primer teléfono que se puede usar y no inventa un país", () => {
    expect(readPhone("01 4567890 / 987 654 321", "PE")).toEqual({ phone: "+51987654321", invalid: ["01 4567890"], others: 0 })
    expect(readPhone("9.87654321E8", "PE").phone).toBe("+51987654321")
    expect(readPhone("4567890", "PE").phone).toBeNull()
  })

  it("lleva a mayúscula inicial solo lo escrito todo en mayúsculas", () => {
    expect(tidyName("MARIA DE LA CRUZ")).toBe("Maria de la Cruz")
    expect(tidyName("  ana   lucía ")).toBe("ana lucía")
  })
})

describe("preparar el plan", () => {
  const text = [
    "HC;Apellidos;Nombres;DNI;Nacimiento;Sexo;Celular;Apoderado;DNI apoderado;Parentesco;Tel. apoderado",
    "1;QUISPE MAMANI;ROSA;45678901;15/11/1990;F;987654322;;;;",
    "2;Quispe Mamani;Lucía;;10/02/2016;F;;Rosa Quispe;45678901;Madre;987654322",
    "3;Torres;Luis;8765432;12/12/85;M;987000111;;;;",
    "4;Ramos;Pedro;;01/01/2000;X;;;;;",
    "5;Soto;Ana;;01/01/2015;F;;Carmen Soto;;Tía;987000999",
  ].join("\n")
  const map = clinicImportMapSchema.parse({
    countryCode: "PE",
    files: [
      {
        path: "pacientes.csv",
        key: "HC",
        columns: {
          givenNames: "Nombres",
          familyName: "Apellidos",
          docNumber: "DNI",
          birthDate: "Nacimiento",
          sex: "Sexo",
          phone: "Celular",
          guardianName: "Apoderado",
          guardianDocNumber: "DNI apoderado",
          guardianKinship: "Parentesco",
          guardianPhone: "Tel. apoderado",
        },
        defaults: { docType: "DNI", guardianDocType: "DNI" },
        dateFormat: "DD/MM/YYYY",
      },
    ],
  })
  const source = { path: "pacientes.csv", name: "pacientes.csv", table: csv(text), sha256: SHA }

  it("une a quien habla por ella con su propia ficha cuando trae el mismo documento", () => {
    const { plan: result } = prepareClinicImport(map, [source])
    const lucia = result.people.find((item) => item.key === "2")!
    expect(lucia.guardian).toEqual({ key: "1", relationship: "guardian", kinship: "MTH" })
    // Sin documento, quien habla por ella es otra persona, sin ficha.
    const ana = result.people.find((item) => item.key === "5")!
    expect(ana.guardian?.key).toBe("5/responsable")
    expect(result.people.find((item) => item.key === "5/responsable")).toMatchObject({ patient: false, demographics: { displayName: "Carmen Soto", phone: "+51987000999" } })
  })

  it("deja fuera, con su motivo, lo que no se puede leer con seguridad", () => {
    const { plan: result, notes } = prepareClinicImport(map, [source])
    expect(result.people.map((item) => item.key)).not.toContain("3")
    expect(result.omitted).toEqual([
      { file: "pacientes.csv", row: 4, reason: expect.stringContaining("2 cifras") },
      { file: "pacientes.csv", row: 5, reason: "El sexo «X» no está en el mapa" },
    ])
    expect(notes.filter((note) => note.level === "fuera")).toHaveLength(2)
  })

  it("aplica lo decidido al revisar: corregir un dato o dejar una fila fuera", () => {
    const reviewed = clinicImportMapSchema.parse({
      ...map,
      overrides: { "3": { set: { birthDate: "1985-12-12" } }, "4": { skip: "Paciente de otra clínica" } },
    })
    const { plan: result } = prepareClinicImport(reviewed, [source])
    const luis = result.people.find((item) => item.key === "3")!
    expect(luis.demographics).toMatchObject({ birthDate: "1985-12-12", docNumber: "08765432" })
    expect(result.omitted).toEqual([{ file: "pacientes.csv", row: 5, reason: "Se dejó fuera: Paciente de otra clínica" }])
  })

  it("sin columna de clave usa una huella que no cambia si se reordena el archivo", () => {
    const noKey = clinicImportMapSchema.parse({ ...map, files: [{ ...map.files[0], key: undefined }] })
    const [header, ...rows] = text.split("\n")
    const a = prepareClinicImport(noKey, [source]).plan.people.map((item) => item.key).sort()
    const b = prepareClinicImport(noKey, [{ ...source, table: csv([header, ...rows.reverse()].join("\n")) }]).plan.people.map((item) => item.key).sort()
    expect(a).toEqual(b)
    expect(a.every((key) => /^h-[0-9a-f]{12}|\/responsable$/.test(key))).toBe(true)
  })

  it("usa el reporte de un sistema tal cual: título arriba, filas vacías y una fila por cita", () => {
    const report = csv(
      [
        "Clínica Ejemplo · Reporte de citas;;;;;",
        "Del 01/01/2026 al 31/10/2026;;;;;",
        ";;;;;",
        "HC;Paciente;DNI;Celular;Fecha cita;Hora",
        "7;ROSA QUISPE;45678901;;12/03/2026;09:00",
        ";;;;;",
        "7;Rosa Quispe;45678901;987654322;20/04/2026;10:30",
        "8;Juan Paz;;987000444;21/04/2026;11:00",
      ].join("\n"),
    )
    const appointments = clinicImportMapSchema.parse({
      countryCode: "PE",
      files: [{ path: "citas.csv", key: "HC", columns: { fullName: "Paciente", docNumber: "DNI", phone: "Celular" }, defaults: { docType: "DNI" }, dateFormat: "DD/MM/YYYY" }],
    })
    const { plan: result, rows } = prepareClinicImport(appointments, [{ path: "citas.csv", name: "citas.csv", table: report, sha256: SHA }])
    expect(rows).toEqual({ "citas.csv": 3 })
    expect(result.people).toEqual([
      expect.objectContaining({ key: "7", origin: { file: "citas.csv", row: 5 }, demographics: expect.objectContaining({ displayName: "Rosa Quispe", phone: "+51987654322" }) }),
      expect.objectContaining({ key: "8", origin: { file: "citas.csv", row: 8 } }),
    ])
    expect(result.omitted).toEqual([{ file: "citas.csv", row: 7, reason: "Es la misma persona de la fila 5 de citas.csv: se toma una vez" }])
  })

  it("dice qué columna del mapa falta si ninguna fila la trae", () => {
    const wrong = clinicImportMapSchema.parse({ ...map, files: [{ ...map.files[0], columns: { ...map.files[0]!.columns, email: "Correo" } }] })
    expect(() => prepareClinicImport(wrong, [source])).toThrow("falta «Correo»")
  })
})

describe("revisar el plan", () => {
  it("bloquea claves repetidas, documentos repetidos y a quien habla por alguien que no está", () => {
    const check = checkClinicImportPlan(
      plan([
        person("1", { givenNames: "Ana", familyName: "Soto", docType: "DNI", docNumber: "12345678", birthDate: "1990-01-01", phone: "+51987000001" }),
        person("2", { givenNames: "Ana María", familyName: "Soto", docType: "DNI", docNumber: "12345678", birthDate: "1991-01-01", phone: "+51987000002" }),
        person("3", { givenNames: "Luis", familyName: "Paz", birthDate: "2015-01-01" }, { guardian: { key: "9", relationship: "guardian" } }),
        person("3", { givenNames: "Otro", familyName: "Paz", birthDate: "2015-01-01", phone: "+51987000003" }),
      ]),
      TODAY,
    )
    expect(check.blocked.sort()).toEqual(["2", "3"])
    expect(check.issues).toContainEqual({ key: "2", level: "error", field: "docNumber", message: "Ese documento ya está en la fila de Ana Soto («1»)" })
  })

  it("carga primero a quien habla por otra persona y bloquea a quien depende de una fila con errores", () => {
    const check = checkClinicImportPlan(
      plan([
        person("hijo", { givenNames: "Mateo", familyName: "Paz", birthDate: "2018-01-01" }, { guardian: { key: "madre", relationship: "guardian" } }),
        person("madre", { givenNames: "Rosa", familyName: "Paz", phone: "+51987000004", docType: "DNI", docNumber: "123" }, { patient: false }),
      ]),
      TODAY,
    )
    expect(check.order).toEqual(["madre", "hijo"])
    expect(check.blocked.sort()).toEqual(["hijo", "madre"])
  })

  it("avisa lo parecido y lo incompleto sin unir a nadie", () => {
    const check = checkClinicImportPlan(
      plan([
        person("1", { givenNames: "José", familyName: "Pérez", birthDate: "1980-05-05", phone: "+51987000005" }),
        person("2", { givenNames: "Jose", familyName: "Perez", phone: "+51987000005" }),
        person("3", { displayName: "Lucía Rojas", birthDate: "2019-03-03" }),
      ]),
      TODAY,
    )
    expect(check.blocked).toEqual([])
    const avisos = check.issues.map((issue) => `${issue.key}: ${issue.message}`)
    expect(avisos).toContain("2: Se llama igual que «1»: revisa si es la misma persona antes de cargar")
    expect(avisos).toContain("2: Comparte el teléfono con «1»: quedan como personas distintas")
    expect(avisos).toContain("3: Es menor de edad y nadie habla por ella")
    expect(avisos).toContain("3: Nombres y apellidos sin separar: quedará en «Faltan datos»")
  })
})
