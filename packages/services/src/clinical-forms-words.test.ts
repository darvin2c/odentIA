import { describe, expect, it } from "vitest"
import { assertAnswers, type FormSchemaDef } from "./clinical-forms.js"

const schema: FormSchemaDef = {
  sections: [
    {
      id: "s1",
      title: "Dolor",
      fields: [
        { id: "intensidad", label: "Intensidad del dolor (0–10)", type: "numero", min: 0, max: 10 },
        { id: "dias", label: "Días con dolor", type: "numero", min: 1 },
        { id: "inicio", label: "Desde cuándo", type: "fecha" },
      ],
    },
  ],
}

/** El guardado del borrador que hace el equipo: lo que no vale se dice en su pregunta. */
function rejectedFor(answers: Record<string, unknown>, stored: Record<string, unknown>) {
  const rejected: Record<string, string> = {}
  assertAnswers(schema, answers, { requireAll: false, rejected, stored, locale: "es-PE" })
  return rejected
}

// QA de la entrega 3 (14 nov): bajo la pregunta se leía «"Intensidad del dolor (0–10)" debe ser ≤ 10»,
// y una fecha guardada salía en ISO.
describe("lo que no se guardó, dicho bajo su pregunta", () => {
  it("el rango con palabras, el valor que no se guardó y lo que sigue guardado", () => {
    expect(rejectedFor({ intensidad: 15 }, { intensidad: 8 })["answers.intensidad"]).toBe(
      "Va de 0 a 10. El 15 no se guardó; sigue «8».",
    )
    expect(rejectedFor({ dias: 0 }, {})["answers.dias"]).toBe("Es de 1 o más. El 0 no se guardó; la pregunta sigue sin respuesta.")
  })

  it("una fecha guardada se dice en el formato de la clínica, no en ISO", () => {
    expect(rejectedFor({ inicio: "14/13/2026" }, { inicio: "2026-11-14" })["answers.inicio"]).toBe(
      "Escribe la fecha completa: día, mes y año. «14/13/2026» no se guardó; sigue «14/11/2026».",
    )
  })

  it("fuera de su pregunta, el mensaje la nombra", () => {
    expect(() => assertAnswers(schema, { intensidad: 15 }, { requireAll: false })).toThrow(
      '"Intensidad del dolor (0–10)" va de 0 a 10',
    )
  })
})
