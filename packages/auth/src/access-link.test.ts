import { describe, expect, it } from "vitest"
import { deviceText, expiresText, markAllows, normalizeEmail, sha256 } from "./access-link.js"
import { isPasswordBreached } from "./password-breach.js"

describe("enlace de acceso", () => {
  it("la marca vale solo para la sesión que abrió el enlace", () => {
    const mark = { session: "tok-a", createdAt: "2026-10-17T13:50:00.000Z" }
    expect(markAllows(mark, { token: "tok-a", createdAt: new Date("2026-10-17T13:50:00Z") })).toBe(
      true,
    )
    expect(markAllows(mark, { token: "tok-b", createdAt: new Date("2026-10-17T13:55:00Z") })).toBe(
      false,
    )
  })

  it("con segundo factor vale para la sesión creada después del enlace, no para una anterior", () => {
    const mark = { session: null, createdAt: "2026-10-17T13:50:00.000Z" }
    expect(markAllows(mark, { token: "x", createdAt: new Date("2026-10-17T13:51:00Z") })).toBe(true)
    expect(markAllows(mark, { token: "y", createdAt: new Date("2026-10-17T09:00:00Z") })).toBe(
      false,
    )
  })

  it("dice la hora a la que vence en la zona de quien lo pidió", () => {
    expect(expiresText(new Date("2026-10-17T14:20:00Z"), "America/Lima")).toBe(
      "9:20 (hora de Lima)",
    )
    expect(expiresText(new Date(), "No/Existe")).toBeUndefined()
    expect(expiresText(new Date(), undefined)).toBeUndefined()
  })

  it("nombra el navegador y el sistema", () => {
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
    expect(deviceText(chrome)).toBe("Chrome en Windows")
    expect(deviceText(undefined)).toBeUndefined()
  })

  it("el mismo correo con otras mayúsculas cuenta igual", () => {
    expect(sha256(normalizeEmail(" Carmen@Sonrisa.pe "))).toBe(sha256("carmen@sonrisa.pe"))
  })
})

describe("contraseñas filtradas", () => {
  // SHA-1 de "password": 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
  it("rechaza la que aparece en la lista", async () => {
    const lookup = async (prefix: string) => {
      expect(prefix).toBe("5BAA6")
      return "1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n0000000000000000000000000000000000A:0"
    }
    expect(await isPasswordBreached("password", lookup)).toBe(true)
  })

  it("acepta la que no aparece o solo aparece como relleno", async () => {
    expect(
      await isPasswordBreached("password", async () => "1E4C9B93F3F0682250B6CF8331B7EE68FD8:0"),
    ).toBe(false)
  })

  it("si el servicio no responde, la acepta", async () => {
    expect(
      await isPasswordBreached("password", async () => {
        throw new Error("sin red")
      }),
    ).toBe(false)
  })
})
