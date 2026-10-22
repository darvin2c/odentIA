import { describe, expect, it } from "vitest"
import { identityText } from "./channels"

describe("identityText", () => {
  it("WhatsApp se lee como el número con el formato de la aplicación, nunca «wa:»", () => {
    const text = identityText({ channel: "whatsapp", externalUserId: "wa:51987654100", displayName: null })
    expect(text).toBe("+51 987 654 100")
    // Aunque el canal entregue el nombre del perfil, lo que identifica la cuenta es su número.
    expect(identityText({ channel: "whatsapp", externalUserId: "wa:51987654100", displayName: "Carmen" })).toBe(
      "+51 987 654 100",
    )
  })

  it("otro canal dice su nombre o de qué canal es, sin el identificador técnico", () => {
    expect(identityText({ channel: "telegram", externalUserId: "tg:123456", displayName: "Carmen H." })).toBe("Carmen H.")
    expect(identityText({ channel: "telegram", externalUserId: "tg:123456", displayName: null })).toBe(
      "Cuenta de Telegram",
    )
  })
})
