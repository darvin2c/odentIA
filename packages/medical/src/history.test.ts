import { describe, expect, it } from "vitest"
import {
  medicalHistoryLines,
  parseMedicalHistory,
  pregnancyWeeks,
  readMedicalHistory,
} from "./history.js"

const TODAY = "2026-10-24"

describe("antecedentes médicos (issue 229, decisión 13)", () => {
  it("guarda embarazo y lactancia con la fecha en que se dijeron, y deja lo común igual", () => {
    const parsed = parseMedicalHistory(
      {
        antecedentesPersonales: { cirugias: "Apendicitis" },
        embarazoLactancia: {
          embarazo: { estado: "si", fecha: "2026-10-10", semanas: 10 },
          lactancia: { estado: "no", fecha: "2026-10-10" },
        },
      },
      TODAY,
    )
    expect(parsed).toEqual({
      ok: true,
      value: {
        antecedentesPersonales: { cirugias: "Apendicitis" },
        embarazoLactancia: {
          embarazo: { estado: "si", fecha: "2026-10-10", semanas: 10 },
          lactancia: { estado: "no", fecha: "2026-10-10" },
        },
      },
    })
    // Sin fecha no vale: la receta necesita saber si sigue vigente.
    expect(
      parseMedicalHistory({ embarazoLactancia: { embarazo: { estado: "si" } } }, TODAY),
    ).toMatchObject({ ok: false })
    expect(
      parseMedicalHistory(
        { embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-12-01" } } },
        TODAY,
      ),
    ).toMatchObject({ ok: false })
  })

  it("las semanas siguen corriendo desde que se dijeron o salen de la última regla", () => {
    const told = readMedicalHistory(
      { embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-10-10", semanas: 10 } } },
      TODAY,
    )
    expect(pregnancyWeeks(told, TODAY)).toBe(12)
    const byFur = readMedicalHistory(
      {
        embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-10-24" } },
        ginecoObstetricos: { fur: "2026-08-01" },
      },
      TODAY,
    )
    expect(pregnancyWeeks(byFur, TODAY)).toBe(12)
    expect(pregnancyWeeks({}, TODAY)).toBeNull()
  })

  it("los partos y las cesáreas no pasan de los embarazos; los cigarrillos, solo si fuma", () => {
    expect(
      parseMedicalHistory({ ginecoObstetricos: { gestas: 1, partos: 1, cesareas: 1 } }, TODAY),
    ).toMatchObject({ ok: false })
    expect(
      parseMedicalHistory(
        { habitos: { tabaco: "dejo", cigarrillosDia: 10, alcohol: "ocasional" } },
        TODAY,
      ),
    ).toEqual({ ok: true, value: { habitos: { tabaco: "dejo", alcohol: "ocasional" } } })
    expect(parseMedicalHistory({ habitos: { tabaco: "mucho" } }, TODAY)).toMatchObject({
      ok: false,
    })
    expect(parseMedicalHistory({ habitos: { drogas: "no" } }, TODAY)).toMatchObject({ ok: false })
  })

  it("las vacunas sin nombre se descartan y un grupo vacío se quita", () => {
    expect(
      parseMedicalHistory(
        { vacunas: [{ vacuna: " Influenza ", fecha: "2026-05-02" }, { vacuna: "" }], habitos: {} },
        TODAY,
      ),
    ).toEqual({ ok: true, value: { vacunas: [{ vacuna: "Influenza", fecha: "2026-05-02" }] } })
  })

  it("en líneas, con fechas y palabras", () => {
    const history = readMedicalHistory(
      {
        embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-10-10", semanas: 10 } },
        ginecoObstetricos: { fur: "2026-08-01", gestas: 2, partos: 1, metodo: "ninguno" },
        habitos: { tabaco: "fuma", cigarrillosDia: 5, actividadFisica: "ligera" },
        vacunas: [{ vacuna: "Influenza", fecha: "2026-05-02" }, { vacuna: "Tétanos" }],
      },
      TODAY,
    )
    expect(medicalHistoryLines(history, TODAY)).toEqual([
      "Embarazada, 12 semanas (registrado el 10/10/2026)",
      "Gineco-obstétricos: última regla 01/08/2026 · 2 embarazo(s) · 1 parto(s) · método: ninguno",
      "Hábitos: tabaco: fuma, 5 al día · actividad física: ligera",
      "Vacunas: Influenza (02/05/2026), Tétanos",
    ])
  })
})
