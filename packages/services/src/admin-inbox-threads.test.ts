import { describe, expect, it } from "vitest"
import {
  firstMessageId,
  inboxPreview,
  outreachThreadKeyOf,
  type ThreadHeaders,
  threadKeyOf,
} from "./admin-inbox.js"

/**
 * El hilo de un correo se arma al leer (ADR 0196): las reglas puras de su clave, gemelas de
 * `emailThreadKeySql` (la prueba con base está en `admin-inbox.test.ts`).
 */

describe("threadKeyOf", () => {
  it("el primer Message-ID de su References, tal como viene (sin minúsculas ni espacios)", () => {
    expect(
      threadKeyOf({
        references: "  <Raiz@Clinica.test>   <hijo@x.test>\n <nieto@x.test>",
        inReplyTo: "<nieto@x.test>",
        messageId: "<propio@x.test>",
      }),
    ).toBe("<Raiz@Clinica.test>")
  })

  it("sin References: la clave de su padre, que se lee de sus propias cabeceras", () => {
    const known: Record<string, ThreadHeaders> = {
      // Un envío nuestro que respondía a otro correo: su References empieza por la raíz.
      "<nuestro@odentia32.com>": {
        references: "<raiz@clinica.test> <nuestro@odentia32.com>",
        messageId: "<nuestro@odentia32.com>",
      },
      // Un correo que llegó sin References, que respondía a otro.
      "<padre@clinica.test>": {
        references: null,
        inReplyTo: "<abuelo@clinica.test>",
        messageId: "<padre@clinica.test>",
      },
    }
    const parentOf = (id: string) => known[id]
    expect(
      threadKeyOf(
        { references: null, inReplyTo: "<nuestro@odentia32.com>", messageId: "<r@x.test>" },
        parentOf,
      ),
    ).toBe("<raiz@clinica.test>")
    expect(
      threadKeyOf(
        { references: null, inReplyTo: "<padre@clinica.test>", messageId: "<r@x.test>" },
        parentOf,
      ),
    ).toBe("<abuelo@clinica.test>")
  })

  it("un In-Reply-To que no conocemos es la clave: dos respuestas a ese correo van juntas", () => {
    const one = threadKeyOf({ inReplyTo: "<ajeno@x.test>", messageId: "<a@x.test>" }, () => null)
    const two = threadKeyOf({ inReplyTo: "<ajeno@x.test>", messageId: "<b@x.test>" })
    expect(one).toBe("<ajeno@x.test>")
    expect(two).toBe(one)
  })

  it("sin cabeceras del hilo: su propio Message-ID", () => {
    expect(threadKeyOf({ references: "", inReplyTo: "sin id", messageId: " <solo@x.test> " })).toBe(
      "<solo@x.test>",
    )
    expect(threadKeyOf({ messageId: "  " })).toBeNull()
  })

  it("lo que no tiene «<…>» no es un Message-ID de la cabecera", () => {
    expect(firstMessageId("abc@x.test, <ok@x.test>")).toBe("<ok@x.test>")
    expect(firstMessageId("<con espacio@x.test>")).toBeNull()
    expect(firstMessageId(null)).toBeNull()
  })
})

describe("outreachThreadKeyOf", () => {
  it("una respuesta va en el hilo del correo que responde, aunque su References diga otro", () => {
    expect(
      outreachThreadKeyOf(
        { references: "<padre@x.test> <respondido@x.test>", messageId: "<nuestro@odentia32.com>" },
        "<raiz@x.test>",
      ),
    ).toBe("<raiz@x.test>")
  })

  it("lo que escribimos primero: su References o su propio Message-ID", () => {
    expect(outreachThreadKeyOf({ references: null, messageId: "<escribir@odentia32.com>" })).toBe(
      "<escribir@odentia32.com>",
    )
    expect(
      outreachThreadKeyOf({ references: "<r@x.test> <m@x.test>", messageId: "<m@x.test>" }, null),
    ).toBe("<r@x.test>")
  })
})

describe("inboxPreview", () => {
  it("las primeras líneas, en una sola, sin lo citado de la respuesta", () => {
    const text = [
      "Hola Ada,",
      "",
      "¿La prueba incluye recordatorios?",
      "> lo que le escribimos antes",
      "El 12 de noviembre de 2026, 10:15, Ada escribió:",
      "> más de lo citado",
      "Gracias",
    ].join("\n")
    expect(inboxPreview(text)).toBe("Hola Ada, ¿La prueba incluye recordatorios?")
  })

  it("hasta 280 caracteres, con «…»; sin texto, nulo", () => {
    const long = inboxPreview("a ".repeat(400))
    expect(long?.length).toBe(280)
    expect(long?.endsWith("…")).toBe(true)
    expect(inboxPreview(null)).toBeNull()
    expect(inboxPreview("  \n > solo citado")).toBeNull()
  })
})
