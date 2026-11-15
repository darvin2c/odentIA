import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { dentalHealth } from "./health"

// Entrega 7 con la causa raíz de la QA del 14 nov: lo que dijo quien cuida a un niño lleva su marca en
// Antecedentes, como el corazón y la anestesia; lo que anotó el equipo, no.
describe("«De pequeño» en Antecedentes", () => {
  const answers = {
    antecedentesOdontologicos: { corazon: { riesgoEndocarditis: "no" }, biberon: "ya_no", chupon: "dedo", quienCepilla: "solo" },
  }
  const page = (props: Parameters<typeof dentalHealth.Summary>[0]) =>
    renderToStaticMarkup(<>{dentalHealth.Summary(props)}</>).replace(/<[^>]+>/g, "|")

  it("dice quién lo dijo mientras nadie lo revisó", () => {
    const html = page({
      answers,
      marks: { corazon: "Lo dijo su madre, Carla, el 14 nov, sin revisar" },
      productMark: "Lo dijo su madre, Carla, el 14 nov, sin revisar",
    })
    expect(html).toMatch(/De pequeño\|+Lo dijo su madre, Carla, el 14 nov, sin revisar/)
    expect(html).toContain("ya no toma biberón · se chupa el dedo")
  })

  it("sin marca, lo anotó el equipo o ya se revisó", () => {
    const html = page({ answers })
    expect(html).toContain("De pequeño")
    expect(html).not.toContain("sin revisar")
  })
})
