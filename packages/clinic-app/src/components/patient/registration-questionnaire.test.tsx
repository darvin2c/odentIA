import { DEFAULT_REGISTRATION_CONFIG, healthQuestionsToAsk } from "@odentia/clinical"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { DraftResumeNotice, draftKeptOnDevice, RegistrationQuestionnaire } from "./registration-questionnaire"

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
    // La anestesia y el sangrado, dos preguntas (H9).
    expect(html).toContain("¿Sangraste mucho después de una extracción?")
    expect(html).not.toContain("o sangraste mucho")
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
    expect(html).not.toContain("¿Tienes alergia a algún medicamento o material?")
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
    expect(html).toContain("¿Thiago tiene alergia a algún medicamento o material?")
    expect(html).toContain("¿Thiago tiene alguna de estas enfermedades?")
    expect(html).toContain("Por ejemplo, asma, convulsiones o problemas de sangrado.")
    expect(html).not.toMatch(/diabetes, presión alta/i)
    expect(html).not.toContain("¿Tienes alergia")
    // Al niño no se le pregunta embarazo ni tabaco.
    expect(html).not.toContain("embarazada")
    expect(html).not.toContain("fuma?")
    expect(html).not.toContain("¿Fumas?")
  })

  it("K7 · a Carla, una sola pregunta de medicinas con palabras de niño: sin warfarina ni osteoporosis", () => {
    declareProduct(bareProduct("dental"))
    const html = childLink(4)
    expect(html).toContain("Las medicinas de Thiago")
    expect(html).toContain("¿Thiago toma alguna medicina, aunque sea a veces?")
    expect(html).toContain("Por ejemplo, inhalador, medicina para las convulsiones o jarabe, todos los días o cuando lo necesita.")
    expect(html).not.toContain("warfarina")
    expect(html).not.toContain("osteoporosis")
    expect(html).not.toContain("todos los días?")
  })

  it("K8 · «Los dientes de Thiago en casa»: biberón, chupón, dulces, flúor y quién le cepilla", () => {
    declareProduct(bareProduct("dental"))
    const html = childLink(6)
    expect(html).toContain("Los dientes de Thiago en casa")
    expect(html).not.toContain("de pequeño")
    expect(html).toContain("¿Thiago toma biberón o pecho para dormir?")
    expect(html).toContain("¿Usa chupón o se chupa el dedo?")
    expect(html).toContain("¿Cuántas veces al día come dulces o toma jugos entre comidas?")
    expect(html).toContain("4 o más")
    expect(html).toContain("¿Su pasta de dientes tiene flúor?")
    expect(html).toContain("¿Quién le cepilla los dientes?")
  })

  // «Sin representante, el paso de quien lo cuida le habla a ella» se prueba con la fecha escrita en
  // `registration-dates.test.tsx`: aquí usaba un estado que el servidor no da (B7 de la 7).
  it("K1 · el enlace sin fecha pregunta quién responde, con el género de la ficha o sin él", () => {
    declareProduct(bareProduct("dental"))
    const link = (sex: "F" | "M" | null, asksWho = true) =>
      page({
        fill: { missing: new Set(["birthDate"]), health: true, hasRepresentative: false, firstName: "Lucía", sex, asksWho },
      }).replace(/<[^>]+>/g, "|")
    expect(link("F")).toContain("¿Eres Lucía o respondes por ella?")
    expect(link("F")).toContain("Respondo por ella|Eres su madre, su padre o quien la cuida")
    expect(link("M")).toContain("¿Eres Lucía o respondes por él?")
    expect(link(null)).toContain("¿Quién responde?")
    expect(link(null)).toContain("Respondo por Lucía|Eres su madre, su padre o un familiar")
    // Con la fecha en su ficha, el servidor no lo pregunta.
    expect(link("F", false)).not.toContain("o respondes por")
  })

  it("en el enlace de Thiago, la casilla del aviso nombra los datos de Thiago y los de Carla, como el registro", () => {
    declareProduct(bareProduct("dental"))
    const fill = { missing: new Set<string>(), health: true, hasRepresentative: true, firstName: "Thiago", age: 6, clinicName: "Dental Smile", privacy: true }
    const child = page({ fill: { ...fill, respondentFirstName: "Carla" } }).replace(/<[^>]+>/g, "|")
    expect(child).toContain("Acepto el aviso de privacidad de Dental Smile para los datos de Thiago y los míos.")
    // Quien abre su propio enlace acepta por sí.
    const own = page({ fill: { ...fill, firstName: "Marta", age: 40, respondentFirstName: null } }).replace(/<[^>]+>/g, "|")
    expect(own).toContain("Acepto el aviso de privacidad de Dental Smile.")
  })

  it("a un niño de 8 años no se le pregunta biberón ni chupón", () => {
    declareProduct(bareProduct("dental"))
    const html = childLink(8)
    expect(html).toContain("Los dientes de Thiago en casa")
    expect(html).not.toContain("biberón")
    expect(html).not.toContain("chupón")
    expect(html).toContain("¿Quién le cepilla los dientes?")
  })

  it("K8 · a una niña se le habla en femenino, o sin pronombre si no se sabe su sexo", () => {
    declareProduct(bareProduct("dental"))
    const asks = {
      ...config,
      fields: { ...config.fields, "personal.cirugias": "optional" as const, "personal.hospitalizaciones": "optional" as const },
    }
    const lucia = (sex: "F" | "M" | null, respondentFirstName: string | null) =>
      page({
        config: asks,
        fill: {
          missing: new Set(),
          health: true,
          healthKeys: new Set(
            healthQuestionsToAsk(asks, { countryCode: "PE", product: "dental", person: { sex, age: 3 } }, new Set()),
          ),
          hasRepresentative: true,
          firstName: "Lucía",
          age: 3,
          sex,
          respondentFirstName,
        },
      }).replace(/<[^>]+>/g, "|")
    const girl = lucia("F", null)
    expect(girl).toContain("Lo respondes tú, que la cuidas.")
    expect(girl).toContain("¿Han operado alguna vez a Lucía?")
    expect(girl).toContain("¿Alguna vez internaron a Lucía en un hospital?")
    expect(girl).not.toMatch(/lo han operado|lo cuidas|internad[oa]/)
    expect(lucia("M", null)).toContain("Lo respondes tú, que lo cuidas.")
    // Sin su sexo, sin pronombre.
    const unknown = lucia(null, null)
    expect(unknown).toContain("Lo respondes tú.")
    expect(unknown).not.toMatch(/que l[ao] cuidas/)
    // El paso de un niño no repite el título en su descripción.
    expect(lucia("F", "Carmen")).toContain("Los dientes de Lucía en casa||Lo respondes tú, Carmen. Nos ayuda a cuidarlos.")
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
    expect(html).toContain("¿Thiago tiene alergia")
    expect(html).not.toContain("¿Quién le cepilla los dientes?")
    expect(html).not.toContain("biberón")
    expect(html).not.toContain("fuma?")
  })
})

// Mesa de formularios del 13 nov, entrega 9: lo escrito queda en el celular un día o hasta enviarlo.
describe("lo escrito en este celular", () => {
  it("guarda solo lo escrito del formulario: nunca el aviso de privacidad ni las novedades, ni lo que no es un campo", () => {
    const kept = draftKeptOnDevice({
      givenNames: "Marta",
      medicationsText: "warfarina 5 mg",
      conditionsPicked: ["diabetes"],
      phoneDigits: 9,
      docType: "DNI",
      privacy: true,
      messages: "si",
      // Lo que no es del formulario (un archivo, otra cosa) no va al celular.
      photo: { name: "dni.jpg" },
      habits: [{ no: "texto" }],
      surnames: 42,
    })
    expect(kept).toEqual({
      givenNames: "Marta",
      medicationsText: "warfarina 5 mg",
      conditionsPicked: ["diabetes"],
      phoneDigits: 9,
      docType: "DNI",
    })
  })

  it("al volver: «Vas en el paso 3 de 6», hasta cuándo sigue y un toque para seguir", () => {
    const html = renderToStaticMarkup(
      <DraftResumeNotice
        step={{ item: "medicines", current: 3, total: 6 }}
        until="hasta mañana, 2:15 p. m."
        onResume={() => {}}
        onRestart={() => {}}
      />,
    )
    expect(html).toContain("Vas en el paso 3 de 6")
    expect(html).toContain("Lo que escribiste sigue guardado en este celular hasta mañana, 2:15 p. m. Todavía no lo enviaste.")
    expect(html).toContain("Seguir donde ibas")
    expect(html).toContain("Empezar de nuevo")
    // Nunca lo que escribió.
    expect(html).not.toContain("warfarina")
  })

  it("antes de saber si el navegador guarda (en el servidor), la pantalla no promete guardar", () => {
    declareProduct(bareProduct("dental"))
    expect(page({ draftKey: "odentia.borrador.x" })).not.toContain("se guarda en este celular")
  })
})

// QA de formularios del 15 nov (K15; ux H2 y D3 de la 7): una sola opción «Madre, padre o tutor» no
// dejaba decir «su madre, Rosa». Tres opciones, con el parentesco que se guarda en el vínculo.
describe("¿Qué eres de…? con madre, padre y tutor legal por separado", () => {
  it("el registro ofrece Madre, Padre y Tutor legal, no «Madre, padre o tutor»", () => {
    declareProduct(bareProduct("dental"))
    const html = page()
    expect(html).toContain("¿Qué eres de")
    expect(html).toContain(">Madre<")
    expect(html).toContain(">Padre<")
    expect(html).toContain(">Tutor legal<")
    expect(html).not.toContain("Madre, padre o tutor")
  })
})
