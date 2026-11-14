import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { RegistrationFieldsPicker } from "./registration-fields-picker"

const text = (product: "dental" | "medical", newKeys = new Set<never>()) => {
  declareProduct(bareProduct(product))
  return renderToStaticMarkup(
    <RegistrationFieldsPicker
      fields={DEFAULT_REGISTRATION_CONFIG.fields}
      onMode={() => {}}
      disabled={false}
      showOrigin
      newKeys={newKeys}
    />,
  ).replace(/<[^>]+>/g, "|")
}

describe("«Preguntas al paciente»: el único lugar donde la clínica decide qué se le pregunta", () => {
  it("odentIA suma el corazón, la anestesia, las dos medicinas, la lactancia y el tabaco", () => {
    const page = text("dental")
    for (const label of [
      "Alergias y qué le pasó",
      "Corazón: válvula, endocarditis o antibiótico antes del dentista",
      "Problemas con la anestesia o sangrado tras una extracción",
      "Anticoagulantes o aspirina diaria",
      "Medicinas para los huesos",
      "Otros medicamentos de todos los días",
      "Lactancia",
      "Fuma y cuántos cigarrillos al día",
    ])
      expect(page).toContain(label)
    expect(page).not.toContain("Si toma alcohol")
  })

  it("latidIA no pregunta lo del dentista y no repite la lactancia ni el tabaco", () => {
    const page = text("medical")
    expect(page).not.toContain("antes del dentista")
    expect(page.match(/Lactancia/g)).toHaveLength(1)
    expect(page.match(/Fuma y cuántos cigarrillos al día/g)).toHaveLength(1)
    expect(page).toContain("Anticoagulantes o aspirina diaria")
  })

  it("las preguntas que nadie de la clínica vio aún dicen «Nueva»", () => {
    const page = text("dental", new Set(["anticoagulants"]) as Set<never>)
    expect(page).toContain("Anticoagulantes o aspirina diaria|Nueva")
    expect(page.match(/Nueva/g)).toHaveLength(1)
  })
})
