import { DEFAULT_REGISTRATION_CONFIG, healthQuestionsToAsk } from "@odentia/clinical"
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

describe("lo de un niño, para quien lo cuida (C3)", () => {
  // Lo que el servidor le pregunta a la mamá de un niño (`healthQuestionsToAsk` con su edad).
  const childLink = (age: number) =>
    page({
      fill: {
        missing: new Set(),
        health: true,
        healthKeys: new Set(
          healthQuestionsToAsk(config, { countryCode: "PE", product: "dental", person: { sex: "M", age } }, new Set()),
        ),
        hasRepresentative: true,
        firstName: "Thiago",
        age,
        respondentFirstName: "Carla",
      },
    }).replace(/<[^>]+>/g, "|")

  it("a Carla se le pregunta por Thiago, con ejemplos de niño y sin «diabetes, presión alta»", () => {
    declareProduct(bareProduct("dental"))
    const html = childLink(6)
    expect(html).toContain("La salud de Thiago")
    expect(html).toContain("Lo respondes tú, Carla.")
    expect(html).toContain("¿Thiago es alérgico a algún medicamento o material?")
    expect(html).toContain("¿Thiago tiene alguna de estas enfermedades?")
    expect(html).toContain("Por ejemplo, asma, convulsiones o problemas de sangrado.")
    expect(html).not.toMatch(/diabetes, presión alta/i)
    expect(html).not.toContain("¿Eres alérgico")
    // Al niño no se le pregunta embarazo ni tabaco.
    expect(html).not.toContain("embarazada")
    expect(html).not.toContain("fuma?")
    expect(html).not.toContain("¿Fumas?")
  })

  it("«Thiago de pequeño»: biberón, chupón, dulces, flúor y quién le cepilla", () => {
    declareProduct(bareProduct("dental"))
    const html = childLink(6)
    expect(html).toContain("Thiago de pequeño")
    expect(html).toContain("¿Thiago toma biberón o pecho para dormir?")
    expect(html).toContain("¿Usa chupón o se chupa el dedo?")
    expect(html).toContain("¿Cuántas veces al día come dulces o toma jugos entre comidas?")
    expect(html).toContain("4 o más")
    expect(html).toContain("¿Su pasta de dientes tiene flúor?")
    expect(html).toContain("¿Quién le cepilla los dientes?")
  })

  it("a un niño de 8 años no se le pregunta biberón ni chupón", () => {
    declareProduct(bareProduct("dental"))
    const html = childLink(8)
    expect(html).toContain("Thiago de pequeño")
    expect(html).not.toContain("biberón")
    expect(html).not.toContain("chupón")
    expect(html).toContain("¿Quién le cepilla los dientes?")
  })

  it("latidIA no pregunta lo de pequeño del dentista, y a un niño tampoco el tabaco", () => {
    declareProduct(bareProduct("medical"))
    const html = page({
      fill: {
        missing: new Set(),
        health: true,
        healthKeys: new Set(
          healthQuestionsToAsk(config, { countryCode: "PE", product: "medical", person: { sex: "M", age: 6 } }, new Set()),
        ),
        hasRepresentative: true,
        firstName: "Thiago",
        age: 6,
        respondentFirstName: "Carla",
      },
    })
    expect(html).toContain("¿Thiago es alérgico")
    expect(html).not.toContain("¿Quién le cepilla los dientes?")
    expect(html).not.toContain("biberón")
    expect(html).not.toContain("fuma?")
  })
})
