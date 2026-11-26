import { describe, expect, it } from "vitest"
import {
  brandMailbox,
  isMailApp,
  mailAppBrand,
  mailAppDomain,
  replyAppOf,
} from "./admin-staff-mail.js"

/** Con qué marca y dominio firma la administración en cada app, sin base. */
describe("la marca de cada app en los correos de la administración", () => {
  it("cada app con su dominio y su marca, gestorIA incluida", () => {
    expect(mailAppDomain("dental")).toBe("odentia32.com")
    expect(mailAppDomain("medical")).toBe("latidia72.com")
    expect(mailAppDomain("optical")).toBe("vistia20.com")
    expect(mailAppDomain("gestoria")).toBe("gestoria24.com")
    expect(mailAppBrand("gestoria")).toBe("gestoria")
    expect(mailAppBrand("optical")).toBe("vistia")
    expect(brandMailbox("gestoria", "hola")).toEqual({
      name: "gestorIA",
      address: "hola@gestoria24.com",
      staffUserId: null,
    })
    expect(brandMailbox("gestoria", "soporte")).toEqual({
      name: "Soporte · gestorIA",
      address: "soporte@gestoria24.com",
      staffUserId: null,
    })
    expect(isMailApp("gestoria")).toBe(true)
    expect(isMailApp("odentia")).toBe(false)
  })

  it("lo que llegó a gestorIA se responde desde gestorIA, aunque el remitente sea cliente de una clínica", () => {
    expect(replyAppOf("gestoria", null)).toBe("gestoria")
    expect(replyAppOf("gestoria", "medical")).toBe("gestoria")
    // En las clínicas, como siempre: la ficha del cliente y, sin cliente, el dominio.
    expect(replyAppOf("medical", "dental")).toBe("dental")
    expect(replyAppOf("optical", null)).toBe("optical")
    expect(replyAppOf("otra", null)).toBe("dental")
  })
})
