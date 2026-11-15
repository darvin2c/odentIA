import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { dentalHealth } from "./health"

// Entrega 7 con la causa raíz de la QA del 14 nov: lo que dijo quien cuida a un niño lleva su marca en
// Antecedentes, como el corazón y la anestesia; lo que anotó el equipo, no. Revisión final del 15 nov
// (K2, K8): la marca va dato por dato y la tarjeta se llama «Los dientes en casa», sin repetir el título.
describe("«Los dientes en casa» en Antecedentes", () => {
  const answers = {
    antecedentesOdontologicos: { corazon: { riesgoEndocarditis: "no" }, biberon: "ya_no", chupon: "dedo", quienCepilla: "solo" },
  }
  const page = (props: Parameters<typeof dentalHealth.Summary>[0]) =>
    renderToStaticMarkup(<>{dentalHealth.Summary(props)}</>).replace(/<[^>]+>/g, "|")

  it("cada dato dice quién lo dijo mientras nadie lo revisó; lo que anotó el equipo, no", () => {
    const html = page({
      answers,
      // Lo dijo la mamá del biberón y del chupón; quién le cepilla lo anotó la doctora.
      marks: { biberon: "Lo dijo su madre, Carla, el 14 nov, sin revisar", chupon: "Lo dijo su madre, Carla, el 14 nov, sin revisar" },
    })
    expect(html).toContain("Los dientes en casa")
    expect(html).not.toContain("De pequeño")
    expect(html).toContain("Biberón o pecho para dormir: ya no toma biberón| · Lo dijo su madre, Carla, el 14 nov, sin revisar")
    expect(html).toContain("Chupón o dedo: se chupa el dedo| · Lo dijo su madre")
    expect(html).toMatch(/Quién le cepilla los dientes: se cepilla sin ayuda\|/)
    expect(html).not.toMatch(/se cepilla sin ayuda\|* · Lo dijo/)
  })

  it("sin marca, lo anotó el equipo o ya se revisó", () => {
    const html = page({ answers })
    expect(html).toContain("Los dientes en casa")
    expect(html).not.toContain("sin revisar")
  })

  it("a un niño no se le titula con el tabaco", () => {
    expect(page({ answers, age: 5 })).toContain("Corazón y anestesia")
    expect(page({ answers, age: 30 })).toContain("Corazón, anestesia, tabaco y alcohol")
  })

  it("«Ver declaración original» y «Revisa con…» traen lo de un niño en casa, dato por dato", () => {
    expect(dentalHealth.declaredRows?.({ dental: { biberon: "si", dulcesEntreComidas: "4_o_mas" } })).toEqual([
      { label: "Biberón o pecho para dormir", value: "Toma biberón o pecho para dormir" },
      { label: "Dulces o jugos entre comidas", value: "4 o más veces al día" },
    ])
    expect(dentalHealth.saidRows?.(answers)).toContainEqual({ keys: ["biberon"], label: "Biberón o pecho para dormir", value: "ya no toma biberón" })
  })
})
