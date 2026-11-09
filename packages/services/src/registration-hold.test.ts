import { clinicalProfileFor, type RegistrationAnswers } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { registrationHoldPatch, registrationHoldRevision, registrationHoldRows, replacedWords } from "./registration-hold.js"

const profile = clinicalProfileFor("PE")
const today = "2026-11-09"
const answers = (demographics: RegistrationAnswers["demographics"]): RegistrationAnswers => ({
  demographics,
  respondent: "patient",
  privacyAccepted: true,
})

describe("«¿Es la misma persona?»", () => {
  it("lo que dice quién es y por dónde se le escribe viene sin marcar; lo demás, marcado", () => {
    const rows = registrationHoldRows(
      answers({ displayName: "Willy Cotrina", givenNames: "Willy", familyName: "Cotrina", sex: "M", phone: "987654321", email: "w@correo.pe", occupation: "Docente", insuranceType: "PRIVADO", insurerName: "Rímac" }),
      { displayName: "Darvin Willy Cotrina", givenNames: "Darvin Willy", familyName: "Cotrina", phone: "+51993029296", sex: "M" },
      { profile, today },
    )
    expect(rows.map((row) => [row.key, row.state, row.checked])).toEqual([
      ["names", "changed", false],
      ["sex", "same", false],
      ["phone", "changed", false],
      ["email", "new", false],
      ["insurance", "new", true],
      ["occupation", "new", true],
    ])
    expect(rows.find((row) => row.key === "insurance")?.declared).toBe("Privado · Rímac")
  })

  it("el nombre se compara entero, también con el que solo se guardó como nombre visible", () => {
    const [changed] = registrationHoldRows(answers({ displayName: "Ana Ríos", givenNames: "Ana", familyName: "Ríos" }), { displayName: "Contacto Previo" }, { profile, today })
    expect(changed).toMatchObject({ key: "names", state: "changed", saved: "Contacto Previo", checked: false })
    const [same] = registrationHoldRows(answers({ displayName: "Ana Ríos", givenNames: "Ana", familyName: "Ríos" }), { displayName: "ana ríos" }, { profile, today })
    expect(same).toMatchObject({ key: "names", state: "same" })
  })

  it("una fecha que la vuelve menor de edad no se guarda desde aquí", () => {
    const [birth] = registrationHoldRows(answers({ displayName: "Ana", birthDate: "2015-05-01" }), { birthDate: "1990-05-01" }, { profile, today })
    expect(birth).toMatchObject({ key: "birthDate", state: "changed", checked: false })
    expect(birth?.blocked).toContain("menor de edad")
  })

  it("el documento se compara pero nunca se guarda", () => {
    const rows = registrationHoldRows(answers({ displayName: "Ana", docType: "DNI", docNumber: "44044243" }), { docType: "DNI", docNumber: "44044244" }, { profile, today })
    expect(rows).toEqual([expect.objectContaining({ key: "document", state: "changed", checked: false, blocked: expect.stringContaining("no se cambia") })])
  })

  it("lo que va junto se guarda junto: la dirección entera, sin el distrito de antes", () => {
    expect(registrationHoldPatch(answers({ displayName: "Ana", address: "Jr. Puno 200" }), ["address"])).toEqual({
      address: "Jr. Puno 200",
      addressReference: null,
      addressCity: null,
      addressDistrict: null,
      addressRegion: null,
      addressPostalCode: null,
      addressCountry: null,
    })
  })

  it("la nota dice lo de antes solo de lo que se reemplazó, y la huella cambia si cambia lo que se ve", () => {
    const rows = registrationHoldRows(
      answers({ displayName: "Ana", birthDate: "1985-01-01", occupation: "Docente" }),
      { birthDate: "1990-05-01" },
      { profile, today },
    )
    expect(replacedWords(rows, ["birthDate", "occupation"])).toBe("nacimiento (antes 01/05/1990)")
    expect(replacedWords(rows, ["occupation"])).toBeNull()
    const other = registrationHoldRows(answers({ displayName: "Ana", birthDate: "1985-01-01", occupation: "Docente" }), { birthDate: "1991-05-01" }, { profile, today })
    expect(registrationHoldRevision("h", rows)).not.toBe(registrationHoldRevision("h", other))
  })
})
