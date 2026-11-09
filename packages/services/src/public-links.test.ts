import { describe, expect, it } from "vitest"
import { clinicOrigin, panelOrigin, personalLinkAddress, productDomainOf } from "./public-links.js"

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

  it("el panel de cada producto: el de odentIA y el de latidIA en su dominio (entrega 4b)", () => {
    expect(panelOrigin("dental", config)).toBe("https://app.odentia32.com")
    expect(panelOrigin("medical", config)).toBe("https://app.latidia72.com")
    // Sin su dominio, latidIA usa el panel de odentIA; sin configurar, ninguno.
    expect(panelOrigin("medical", { webURL: "https://app.odentia32.com", cookieDomain: "odentia32.com" })).toBe(
      "https://app.odentia32.com",
    )
    expect(panelOrigin("medical", null)).toBeNull()
  })
})

describe("un enlace por cosa: el destino va en la dirección, con el token al final", () => {
  const origin = "https://sonrie.odentia32.com"
  it("«Elige tu cita», la lista «Tus pendientes» o directo una cosa", () => {
    expect(personalLinkAddress(origin, "t0k")).toBe(`${origin}/reserva?token=t0k`)
    expect(personalLinkAddress(origin, "t0k", "pendientes")).toBe(`${origin}/pendientes?token=t0k`)
    expect(personalLinkAddress(origin, "t0k", "firma")).toBe(`${origin}/pendientes?abre=firma&token=t0k`)
    // Con `id`, abre ese consentimiento o ese presupuesto; las demás cosas no lo llevan.
    expect(personalLinkAddress(origin, "t0k", "firma", "c1")).toBe(`${origin}/pendientes?abre=firma&id=c1&token=t0k`)
    expect(personalLinkAddress(origin, "t0k", "presupuesto", "b1")).toBe(`${origin}/pendientes?abre=presupuesto&id=b1&token=t0k`)
    expect(personalLinkAddress(origin, "t0k", "datos", "x")).toBe(`${origin}/pendientes?abre=datos&token=t0k`)
    // El botón de una plantilla lleva el token como único dato, al final.
    expect(personalLinkAddress(origin, "{{1}}", "cita").endsWith("&token={{1}}")).toBe(true)
  })
})
