import { describe, expect, it } from "vitest"
import { commonInterviewEntries, PREGNANCY_ENTRY_KEY } from "./interview.js"

const TODAY = "2026-11-27"
const pregnancyOf = (answers: unknown, legacySaidOn?: string) =>
  commonInterviewEntries(answers, TODAY, { legacySaidOn }).find((entry) => entry.key === PREGNANCY_ENTRY_KEY)

describe("la entrevista de salud en palabras (copia de la historia)", () => {
  it("dice los antecedentes personales en el orden de la pantalla, y después el embarazo", () => {
    expect(
      commonInterviewEntries(
        {
          embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13", semanas: 30 } },
          antecedentesPersonales: { transfusiones: " Ninguna ", hospitalizaciones: "Neumonía en 2019" },
        },
        TODAY,
      ),
    ).toEqual([
      { key: "antecedentesPersonales.hospitalizaciones", label: "Hospitalizaciones", value: "Neumonía en 2019" },
      { key: "antecedentesPersonales.transfusiones", label: "Transfusiones", value: "Ninguna" },
      // La semana de hoy y, entre paréntesis, la que se dijo el día en que se dijo.
      { key: PREGNANCY_ENTRY_KEY, label: "Embarazo", value: "Sí · 32 semanas a la fecha de esta copia (30 semanas el 13/11/2026)" },
    ])
  })

  it("el embarazo guardado antes, sin fecha, se lee igual y con la misma clave", () => {
    const old = { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 30 } }
    // Su fecha es la del día en que se anotó ese «sí», que sale de las versiones de la entrevista.
    expect(pregnancyOf(old, "2026-11-13")).toEqual({
      key: PREGNANCY_ENTRY_KEY,
      label: "Embarazo",
      value: "Sí · 32 semanas a la fecha de esta copia (30 semanas el 13/11/2026)",
    })
    // Sin fecha de verdad ya no se afirma.
    expect(pregnancyOf(old)?.value).toBe("Por confirmar: anotado sin fecha")
    expect(pregnancyOf({ antecedentesPersonales: { embarazo: false } })?.value).toBe("No")
  })

  it("sin las semanas dice cuándo lo dijo; pasado su término, que está por confirmar; un «no», con su día", () => {
    expect(pregnancyOf({ embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13" } } })?.value).toBe(
      "Sí · lo dijo el 13/11/2026, sin las semanas",
    )
    expect(pregnancyOf({ embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-01-05", semanas: 30 } } })?.value).toBe(
      "Por confirmar: lo dijo el 05/01/2026, con 30 semanas, y ya pasó el tiempo de un embarazo",
    )
    expect(pregnancyOf({ embarazoLactancia: { embarazo: { estado: "no", fecha: "2026-11-13" } } })?.value).toBe(
      "No · lo dijo el 13/11/2026",
    )
    expect(pregnancyOf({ embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-20", semanas: 1 } } })?.value).toBe(
      "Sí · 2 semanas a la fecha de esta copia (1 semana el 20/11/2026)",
    )
    // Dicho el mismo día de la copia, la semana se dice una vez y con su día.
    expect(pregnancyOf({ embarazoLactancia: { embarazo: { estado: "si", fecha: TODAY, semanas: 30 } } })?.value).toBe(
      "Sí · 30 semanas (lo dijo el 27/11/2026)",
    )
  })

  it("lo que no se respondió no sale", () => {
    expect(commonInterviewEntries({ antecedentesPersonales: { cirugias: "" } }, TODAY)).toEqual([])
    expect(commonInterviewEntries(null, TODAY)).toEqual([])
    expect(commonInterviewEntries({ antecedentesOdontologicos: { bruxismo: true } }, TODAY)).toEqual([])
  })

  it("lo que una entrevista antigua guardaba como texto sale como registro anterior", () => {
    expect(
      commonInterviewEntries(
        { antecedentesFamiliares: "Madre diabética", antecedentesPersonales: { enfermedades: "Hipertensión" } },
        TODAY,
      ).map((entry) => `${entry.label}: ${entry.value}`),
    ).toEqual(["Enfermedades (registro anterior): Hipertensión", "Antecedentes familiares (registro anterior): Madre diabética"])
  })
})
