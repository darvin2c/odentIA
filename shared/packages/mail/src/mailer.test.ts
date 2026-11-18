import { describe, expect, it } from "vitest"
import { mailOptionsOf } from "./index.js"

const env = {
  host: "smtp.test",
  port: 587,
  from: "odentIA <no-reply@odentia32.com>",
  fromByBrand: { latidia: "latidIA <no-reply@latidia72.com>" },
}

const base = { to: "dra@gmail.com", subject: "Hola", html: "<p>Hola</p>", text: "Hola" }

describe("lo que sale por el servidor de correo", () => {
  it("sin remitente propio, el de la marca; sin cabeceras ni Message-ID", () => {
    const options = mailOptionsOf(env, { ...base, brand: "latidia" })
    expect(options.from).toBe("latidIA <no-reply@latidia72.com>")
    expect(options.headers).toBeUndefined()
    expect(options.messageId).toBeUndefined()
    expect(options.replyTo).toBeUndefined()
  })

  it("una conversación sale con quien escribe, su respuesta a él, su Message-ID y el hilo", () => {
    const options = mailOptionsOf(env, {
      ...base,
      brand: "latidia",
      from: { name: "Ada Lovelace · latidIA", address: "ada.lovelace@latidia72.com" },
      replyTo: "ada.lovelace@latidia72.com",
      messageId: "<r1@latidia72.com>",
      headers: { "In-Reply-To": "<a@gmail.com>", References: "<x@gmail.com> <a@gmail.com>" },
    })
    // El remitente explícito gana sobre el de la marca; el nombre lo codifica Nodemailer.
    expect(options.from).toEqual({
      name: "Ada Lovelace · latidIA",
      address: "ada.lovelace@latidia72.com",
    })
    expect(options.replyTo).toBe("ada.lovelace@latidia72.com")
    expect(options.messageId).toBe("<r1@latidia72.com>")
    expect(options.headers).toEqual({
      "In-Reply-To": "<a@gmail.com>",
      References: "<x@gmail.com> <a@gmail.com>",
    })
  })

  it("una cabecera con salto de línea no pasa: nadie inyecta otra", () => {
    expect(() =>
      mailOptionsOf(env, { ...base, headers: { "In-Reply-To": "<a@x>\r\nBcc: otro@x" } }),
    ).toThrow()
    expect(() => mailOptionsOf(env, { ...base, messageId: "<a@x>\nBcc: otro@x" })).toThrow()
  })
})
