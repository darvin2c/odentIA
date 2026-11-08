import { describe, expect, it } from "vitest"
import { looksLikeQuestion, searchStatusText } from "./global-search"

describe("lo escrito en el buscador", () => {
  it("una pregunta no se confunde con un nombre", () => {
    for (const text of ["¿cómo bloqueo un horario?", "como bloqueo un horario", "qué es un presupuesto", "Qué hago", "por qué no me deja", "cuánto cobramos", "no encuentro la agenda"]) {
      expect(looksLikeQuestion(text), text).toBe(true)
    }
  })

  it("un nombre no se confunde con una pregunta", () => {
    for (const text of ["Zoila Torres", "Queirolo", "Cuando", "Comotto Ana", "Donde", "Nomeolvides"]) {
      expect(looksLikeQuestion(text), text).toBe(text === "Cuando" || text === "Donde")
    }
  })
})

// QA del 6 nov (B8): «1 personas, 2 resultados».
describe("lo que oye el lector de pantalla al buscar", () => {
  it("cada palabra concuerda con su número", () => {
    expect(searchStatusText(1, 2)).toBe("1 persona, 2 resultados")
    expect(searchStatusText(0, 1)).toBe("0 personas, 1 resultado")
  })
})
