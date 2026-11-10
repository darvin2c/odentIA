import { describe, expect, it } from "vitest"
import { phoneWithoutWhatsAppReason } from "./automation-routing.js"

describe("por qué el teléfono de su ficha no es una vía", () => {
  const facts = {
    clinicWhatsApp: true,
    testNumber: false,
    numberProblem: false,
    ownedByOther: false,
  }

  it("sin nada en contra, es que nadie lo marcó como su WhatsApp", () => {
    expect(phoneWithoutWhatsAppReason(facts)).toBe("aun_no")
  })

  it("manda lo de la clínica, después lo del número y después de quién es", () => {
    const all = { clinicWhatsApp: false, testNumber: true, numberProblem: true, ownedByOther: true }
    expect(phoneWithoutWhatsAppReason(all)).toBe("clinica_sin_whatsapp")
    expect(phoneWithoutWhatsAppReason({ ...all, clinicWhatsApp: true })).toBe("numero_de_prueba")
    expect(phoneWithoutWhatsAppReason({ ...facts, numberProblem: true, ownedByOther: true })).toBe(
      "no_parece_celular",
    )
    expect(phoneWithoutWhatsAppReason({ ...facts, ownedByOther: true })).toBe("de_otra_persona")
  })
})
