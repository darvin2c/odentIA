import { describe, expect, it } from "vitest"
import { claimsOf } from "./claims"

describe("lo que la respuesta dice que se hizo (auditoría del ADR 0104)", () => {
  it("reconoce que el equipo lo verá o que se lo pasó, en los dos idiomas", () => {
    for (const text of [
      "Recepción revisará tu atención en Miraflores y te escribirá por aquí.",
      "Un profesional revisará tu consulta sobre el sangrado de encías.",
      "Ya se lo hice llegar al equipo.",
      "I'll pass this to the team so they can look into it.",
      "Our team is reviewing your question.",
    ]) {
      expect(claimsOf(text).team, text).toBe(true)
    }
  })

  it("reconoce que dice haber anotado algo", () => {
    for (const text of ["Ya dejé anotado que no puedes llamar.", "Tomé nota de que lo necesitas hoy.", "I've noted your request."]) {
      expect(claimsOf(text).note, text).toBe(true)
    }
  })

  it("lo demás no es decir que se hizo algo", () => {
    for (const text of [
      "¿Te reservo el jueves a las 10:00?",
      "Con gusto, María. Estamos atentos si quieres volver a escribirnos.",
      "La limpieza dura 45 minutos y cuesta S/ 79.",
      "Puedes dejarla en recepción de Miraflores, en Av. José Larco 345.",
      "Our team will be happy to see you on Thursday.",
    ]) {
      expect(claimsOf(text), text).toEqual({ team: false, note: false })
    }
  })
})
