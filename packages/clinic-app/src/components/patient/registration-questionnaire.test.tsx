import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { RegistrationQuestionnaire } from "./registration-questionnaire"

const config = { ...DEFAULT_REGISTRATION_CONFIG, enabled: true, privacyNotice: "Aviso de demostración" }
const page = (props: Partial<Parameters<typeof RegistrationQuestionnaire>[0]> = {}) =>
  renderToStaticMarkup(
    <RegistrationQuestionnaire config={config} today="2026-11-13" countryCode="PE" onSubmit={async () => {}} {...props} />,
  )

describe("las preguntas de salud nuevas en el registro y en su enlace", () => {
  it("odentIA: «Tus medicinas» va aparte, con anticoagulantes, huesos y «algún otro»; el corazón y la anestesia en «Tu salud»", () => {
    declareProduct(bareProduct("dental"))
    const html = page()
    expect(html).toContain("Tus medicinas")
    expect(html).toContain("para que la sangre no forme coágulos, o aspirina todos los días?")
    expect(html).toContain("medicinas para los huesos, por osteoporosis o por un cáncer?")
    expect(html).toContain("¿Tomas algún otro medicamento todos los días?")
    expect(html).toContain("tuviste una infección en el corazón (endocarditis)?")
    expect(html).toContain("¿Tuviste algún problema con la anestesia del dentista")
    expect(html).toContain("¿Tienes alguna de estas enfermedades?")
    expect(html).toContain("¿Fumas?")
    // El corazón y la anestesia son del dentista: el consultorio de latidIA no los pregunta.
    declareProduct(bareProduct("medical"))
    expect(page()).not.toContain("(endocarditis)")
  })

  it("en su enlace se le pregunta solo lo que falta: lo que el equipo ya anotó no se le muestra", () => {
    declareProduct(bareProduct("dental"))
    const html = page({
      fill: {
        missing: new Set(),
        health: true,
        healthKeys: new Set(["anticoagulants", "boneMedicines"]),
        hasRepresentative: true,
        firstName: "Marta",
      },
    })
    expect(html).toContain("para que la sangre no forme coágulos")
    expect(html).not.toContain("¿Eres alérgico a algún medicamento o material?")
    expect(html).not.toContain("¿Tienes alguna de estas enfermedades?")
  })
})
