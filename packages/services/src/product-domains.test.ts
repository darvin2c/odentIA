import { describe, expect, it } from "vitest"
import { isOnDomain, mailBrandDomains, onDomain, productOfHost, trustedOriginsOn } from "./product-domains.js"

describe("los dos dominios de una instalación (decisión 9 del issue 229)", () => {
  it("lleva una dirección de odentIA al dominio de latidIA, con su esquema y su puerto", () => {
    expect(onDomain("https://api.odentia32.com", "odentia32.com", "latidia72.com")).toBe(
      "https://api.latidia72.com",
    )
    expect(
      onDomain("https://app.odentia.localhost:1355/", ".odentia.localhost", "latidia.localhost"),
    ).toBe("https://app.latidia.localhost:1355/")
    expect(onDomain("https://*.odentia32.com", "odentia32.com", "latidia72.com")).toBe(
      "https://*.latidia72.com",
    )
    expect(onDomain("https://odentia32.com", "odentia32.com", "latidia72.com")).toBe(
      "https://latidia72.com",
    )
    // Lo que no es de ese dominio, o solo lo parece, queda igual.
    expect(onDomain("https://app.notodentia32.com", "odentia32.com", "latidia72.com")).toBe(
      "https://app.notodentia32.com",
    )
    expect(onDomain("https://odentia32.com.evil.test", "odentia32.com", "latidia72.com")).toBe(
      "https://odentia32.com.evil.test",
    )
  })

  it("reconoce el producto de cada host", () => {
    const domains = { dental: "odentia32.com", medical: "latidia72.com", optical: "vistia20.com" }
    expect(productOfHost("api.latidia72.com", domains)).toBe("medical")
    expect(productOfHost("claridad.vistia20.com", domains)).toBe("optical")
    expect(productOfHost("app.vistia20.com", domains)).toBe("optical")
    expect(productOfHost("vistia20.com.evil.test", domains)).toBeNull()
    expect(productOfHost("sonrie.odentia32.com:443", domains)).toBe("dental")
    expect(productOfHost("latidia72.com", domains)).toBe("medical")
    expect(productOfHost("latidia72.com.evil.test", domains)).toBeNull()
    expect(isOnDomain("https://admin.odentia32.com", "odentia32.com")).toBe(true)
  })

  it("los orígenes de confianza de latidIA son los de odentIA en su dominio, sin la administración", () => {
    expect(
      trustedOriginsOn(
        [
          "https://odentia32.com",
          "https://app.odentia32.com",
          "https://admin.odentia32.com",
          "https://*.odentia32.com",
          "https://otra.test",
        ],
        "odentia32.com",
        "latidia72.com",
        ["https://admin.odentia32.com"],
      ),
    ).toEqual(["https://latidia72.com", "https://app.latidia72.com", "https://*.latidia72.com"])
  })
})

describe("el pie de los correos de cada marca", () => {
  it("lleva la web de la marca de cada producto con dominio propio, y nada sin dominio", () => {
    expect(mailBrandDomains({ medical: "latidia72.com", optical: "vistia20.com" })).toEqual({
      latidia: "latidia72.com",
      vistia: "vistia20.com",
    })
    expect(mailBrandDomains({ medical: "latidia72.com", optical: undefined })).toEqual({ latidia: "latidia72.com" })
    expect(mailBrandDomains({ medical: undefined, optical: undefined })).toEqual({})
  })
})
