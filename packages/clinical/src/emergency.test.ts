import { describe, expect, it } from "vitest"
import { emergencyAdvice, emergencyNumberFor, urgentClinicPhone } from "./emergency.js"

describe("a dónde llamar ante una emergencia (ADR 0084)", () => {
  it("cada país con su número comprobado; sin número, ninguno inventado", () => {
    expect(emergencyNumberFor("PE")).toBe("106")
    expect(emergencyNumberFor("co")).toBe("123")
    expect(emergencyNumberFor("CL")).toBe("131")
    expect(emergencyNumberFor("MX")).toBe("911")
    expect(emergencyNumberFor("SV")).toBe("132")
    expect(emergencyNumberFor("ES")).toBeNull()
    expect(emergencyNumberFor(null)).toBeNull()
  })

  it("la frase dice el número del país y el de la clínica, en el trato de la clínica", () => {
    expect(emergencyAdvice("106", "+5115550123")).toBe(
      "Si es una emergencia, llama ahora al 106 o ve a la emergencia más cercana. También puedes llamar a la clínica al +5115550123.",
    )
    expect(emergencyAdvice("106", null, "usted")).toBe("Si es una emergencia, llame ahora al 106 o vaya a la emergencia más cercana.")
    expect(emergencyAdvice(null, null)).toBe("Si es una emergencia, ve ahora a la emergencia más cercana.")
  })

  it("una urgencia sin peligro para la vida da solo el teléfono de la clínica, nunca el de emergencias", () => {
    expect(urgentClinicPhone("+5115550123")).toBe("Si es urgente, puedes llamar a la clínica al +5115550123.")
    expect(urgentClinicPhone("+5115550123", "usted")).toBe("Si es urgente, puede llamar a la clínica al +5115550123.")
    expect(urgentClinicPhone(null)).toBeNull()
  })
})
