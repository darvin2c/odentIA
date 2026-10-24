import { describe, expect, it } from "vitest"
import { clinicOrigin, productDomainOf } from "./public-links.js"

const config = {
  webURL: "https://app.odentia32.com",
  cookieDomain: "odentia32.com",
  productDomains: { medical: "latidia72.com" },
}

describe("la dirección de cada clínica, en el dominio de su producto (decisión 9 del issue 229)", () => {
  it("odentIA en odentia32.com y latidIA en latidia72.com", () => {
    expect(clinicOrigin("sonrie", "dental", config)).toBe("https://sonrie.odentia32.com")
    expect(clinicOrigin("sanmartin", "medical", config)).toBe("https://sanmartin.latidia72.com")
    expect(productDomainOf("medical", config)).toBe("latidia72.com")
  })

  it("un producto sin dominio propio va en el de odentIA, con el puerto de la plataforma", () => {
    const local = {
      webURL: "https://app.odentia.localhost:1355",
      cookieDomain: ".odentia.localhost",
    }
    expect(clinicOrigin("sanmartin", "medical", local)).toBe(
      "https://sanmartin.odentia.localhost:1355",
    )
    expect(clinicOrigin("", "dental", local)).toBeNull()
    expect(clinicOrigin("sonrie", "dental", null)).toBeNull()
  })
})
