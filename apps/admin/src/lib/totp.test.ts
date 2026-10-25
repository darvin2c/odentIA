import { describe, expect, it } from "vitest"
import { backupCodesText, groupedSecret, totpDigits, totpQrDataUrl, totpSecret } from "./totp"

const uri =
  "otpauth://totp/odentIA:darvin%40odentia32.com?secret=jbswy3dpehpk3pxp&issuer=odentIA&digits=6&period=30"

describe("lo que la pantalla de Seguridad de acceso muestra del enlace", () => {
  it("la clave se lee del enlace y se agrupa de a 4 para escribirla a mano", () => {
    expect(totpSecret(uri)).toBe("JBSWY3DPEHPK3PXP")
    expect(groupedSecret(totpSecret(uri))).toBe("JBSW Y3DP EHPK 3PXP")
    expect(totpSecret("otpauth://totp/x?issuer=y")).toBe("")
  })

  it("el campo deja solo los 6 dígitos, también al pegar con espacios", () => {
    expect(totpDigits("482 913")).toBe("482913")
    expect(totpDigits("12a34567")).toBe("123456")
  })

  it("el QR es una imagen SVG del mismo enlace", async () => {
    const url = await totpQrDataUrl(uri)
    expect(url.startsWith("data:image/svg+xml")).toBe(true)
    expect(decodeURIComponent(url)).toContain("<svg")
  })

  it("el archivo de los códigos dice de qué cuenta son y trae todos", () => {
    const text = backupCodesText("darvin@odentia32.com", ["k7rq-2mfp", "x9tb-4wza"])
    expect(text).toContain("darvin@odentia32.com")
    expect(text).toContain("k7rq-2mfp\nx9tb-4wza")
  })
})
