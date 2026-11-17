import { describe, expect, it } from "vitest"
import {
  firstMessageId,
  headerThreadKeyOf,
  inboxPreview,
  outreachThreadKeyOf,
  type ThreadHeaders,
  threadKeyOf,
} from "./admin-inbox.js"

/**
 * El hilo de un correo se arma al leer (ADR 0196): las reglas puras de su clave, gemelas de
 * `emailThreadKeySql` (la prueba con base está en `admin-inbox.test.ts`).
 */

/** Quién está en cada hilo, como lo diría `threadAddressSql`. */
const members =
  (byKey: Record<string, string[]>) =>
  (key: string): readonly string[] =>
    byKey[key] ?? []

describe("threadKeyOf", () => {
  it("el primer Message-ID de su References, tal como viene (sin minúsculas ni espacios)", () => {
    expect(
      threadKeyOf(
        {
          references: "  <Raiz@Clinica.test>   <hijo@x.test>\n <nieto@x.test>",
          inReplyTo: "<nieto@x.test>",
          messageId: "<propio@x.test>",
          fromAddress: "Rosa@Clinica.test",
          senderVerified: true,
        },
        undefined,
        members({ "<Raiz@Clinica.test>": ["rosa@clinica.test"] }),
      ),
    ).toBe("<Raiz@Clinica.test>")
  })

  it("quien no está en el hilo no entra aunque traiga su Message-ID: es su propia conversación", () => {
    const spoofed = {
      references: "<raiz@clinica.test> <nuestro@odentia32.com>",
      inReplyTo: "<nuestro@odentia32.com>",
      messageId: "<falso@otro.test>",
      fromAddress: "alguien@otro.test",
      senderVerified: true,
    }
    const inThread = members({ "<raiz@clinica.test>": ["rosa@clinica.test"] })
    expect(threadKeyOf(spoofed, undefined, inThread)).toBe("<falso@otro.test>")
    // Sin nadie en el hilo, tampoco entra; sus cabeceras igual apuntan ahí.
    expect(threadKeyOf(spoofed, undefined, members({}))).toBe("<falso@otro.test>")
    expect(headerThreadKeyOf(spoofed)).toBe("<raiz@clinica.test>")
    // Quien sí está entra, con o sin mayúsculas.
    const rosa = { ...spoofed, fromAddress: " ROSA@clinica.test " }
    expect(threadKeyOf(rosa, undefined, inThread)).toBe("<raiz@clinica.test>")
    // Un From sin verificar puede ser de cualquiera: aunque sea el de Rosa, no entra.
    expect(threadKeyOf({ ...rosa, senderVerified: false }, undefined, inThread)).toBe(
      "<falso@otro.test>",
    )
    expect(threadKeyOf({ ...rosa, senderVerified: undefined }, undefined, inThread)).toBe(
      "<falso@otro.test>",
    )
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
    const inThread = members({
      "<raiz@clinica.test>": ["r@x.test"],
      "<abuelo@clinica.test>": ["r@x.test"],
    })
    expect(
      threadKeyOf(
        {
          references: null,
          inReplyTo: "<nuestro@odentia32.com>",
          messageId: "<r@x.test>",
          fromAddress: "r@x.test",
          senderVerified: true,
        },
        parentOf,
        inThread,
      ),
    ).toBe("<raiz@clinica.test>")
    expect(
      threadKeyOf(
        {
          references: null,
          inReplyTo: "<padre@clinica.test>",
          messageId: "<r@x.test>",
          fromAddress: "r@x.test",
          senderVerified: true,
        },
        parentOf,
        inThread,
      ),
    ).toBe("<abuelo@clinica.test>")
  })

  it("una cadena que solo trae In-Reply-To sube hasta su primer correo, con lo que le respondimos", () => {
    // La raíz ← a ← b ← c, cada uno solo con In-Reply-To; nuestra respuesta a b lleva «a b» (la
    // References que arma `replyReferences`) y lo que la contesta, «a b nuestra».
    const known: Record<string, ThreadHeaders> = {
      "<raiz@c.test>": { messageId: "<raiz@c.test>" },
      "<a@c.test>": { inReplyTo: "<raiz@c.test>", messageId: "<a@c.test>" },
      "<b@c.test>": { inReplyTo: "<a@c.test>", messageId: "<b@c.test>" },
      "<nuestra@odentia32.com>": {
        references: "<a@c.test> <b@c.test>",
        messageId: "<nuestra@odentia32.com>",
      },
    }
    const parentOf = (id: string) => known[id]
    expect(headerThreadKeyOf({ inReplyTo: "<b@c.test>", messageId: "<c@c.test>" }, parentOf)).toBe(
      "<raiz@c.test>",
    )
    expect(
      headerThreadKeyOf(
        {
          references: "<a@c.test> <b@c.test> <nuestra@odentia32.com>",
          inReplyTo: "<nuestra@odentia32.com>",
          messageId: "<d@c.test>",
        },
        parentOf,
      ),
    ).toBe("<raiz@c.test>")
    expect(
      outreachThreadKeyOf(
        { references: "<a@c.test> <b@c.test>", messageId: "<nuestra@odentia32.com>" },
        null,
        parentOf,
      ),
    ).toBe("<raiz@c.test>")
    // Un eslabón que no conocemos corta la cadena ahí: ese id es la clave.
    expect(
      headerThreadKeyOf({ inReplyTo: "<b@c.test>", messageId: "<c@c.test>" }, (id) =>
        id === "<a@c.test>" ? undefined : known[id],
      ),
    ).toBe("<a@c.test>")
    // Una cadena en círculo no da vueltas sin fin.
    const loop: Record<string, ThreadHeaders> = {
      "<x@c.test>": { inReplyTo: "<y@c.test>", messageId: "<x@c.test>" },
      "<y@c.test>": { inReplyTo: "<x@c.test>", messageId: "<y@c.test>" },
    }
    expect(
      headerThreadKeyOf({ inReplyTo: "<x@c.test>", messageId: "<z@c.test>" }, (id) => loop[id]),
    ).toMatch(/^<[xy]@c\.test>$/)
    // Un correo que se responde a sí mismo es su propio hilo.
    expect(
      headerThreadKeyOf({ inReplyTo: "<s@c.test>", messageId: "<s@c.test>" }, () => ({
        inReplyTo: "<s@c.test>",
        messageId: "<s@c.test>",
      })),
    ).toBe("<s@c.test>")
  })

  it("el colega de la clínica entra en su hilo: por su correo exacto o porque una persona lo ligó", () => {
    const colleague = {
      references: "<raiz@clinica.test> <nuestro@odentia32.com>",
      messageId: "<colega@clinica.test>",
      fromAddress: "colega@clinica.test",
      senderVerified: true,
      clientId: "cliente-a",
    }
    const inThread = members({ "<raiz@clinica.test>": ["rosa@clinica.test"] })
    const clientsIn = (key: string) => (key === "<raiz@clinica.test>" ? ["cliente-a"] : [])
    for (const matchedBy of ["contacto", "solicitud", "miembro", "persona"])
      expect(threadKeyOf({ ...colleague, matchedBy }, undefined, inThread, clientsIn)).toBe(
        "<raiz@clinica.test>",
      )
    // Ligado por el hilo, de otra clínica, sin cliente o sin verificar: su propia conversación.
    const apart = "<colega@clinica.test>"
    expect(threadKeyOf({ ...colleague, matchedBy: "hilo" }, undefined, inThread, clientsIn)).toBe(
      apart,
    )
    expect(
      threadKeyOf(
        { ...colleague, clientId: "cliente-b", matchedBy: "contacto" },
        undefined,
        inThread,
        clientsIn,
      ),
    ).toBe(apart)
    expect(
      threadKeyOf(
        { ...colleague, clientId: null, matchedBy: null },
        undefined,
        inThread,
        clientsIn,
      ),
    ).toBe(apart)
    expect(
      threadKeyOf(
        { ...colleague, matchedBy: "persona", senderVerified: false },
        undefined,
        inThread,
        clientsIn,
      ),
    ).toBe(apart)
    // Sin saber de qué clínica es el hilo, no entra.
    expect(threadKeyOf({ ...colleague, matchedBy: "contacto" }, undefined, inThread)).toBe(apart)
  })

  it("un In-Reply-To que no conocemos es la clave: dos respuestas suyas a ese correo van juntas", () => {
    // Del hilo de un correo que no conocemos es quien escribió primero apuntándole.
    const inThread = members({ "<ajeno@x.test>": ["ana@x.test"] })
    const ana = { fromAddress: "ana@x.test", senderVerified: true }
    const one = threadKeyOf(
      { ...ana, inReplyTo: "<ajeno@x.test>", messageId: "<a@x.test>" },
      () => null,
      inThread,
    )
    const two = threadKeyOf(
      { ...ana, inReplyTo: "<ajeno@x.test>", messageId: "<b@x.test>" },
      undefined,
      inThread,
    )
    expect(one).toBe("<ajeno@x.test>")
    expect(two).toBe(one)
    // Otra persona que responde lo mismo queda en su propia conversación.
    expect(
      threadKeyOf(
        {
          inReplyTo: "<ajeno@x.test>",
          messageId: "<c@y.test>",
          fromAddress: "otro@y.test",
          senderVerified: true,
        },
        undefined,
        inThread,
      ),
    ).toBe("<c@y.test>")
  })

  it("sin cabeceras del hilo: su propio Message-ID, verificado o no", () => {
    expect(
      threadKeyOf(
        { references: "", inReplyTo: "sin id", messageId: " <solo@x.test> " },
        undefined,
        members({}),
      ),
    ).toBe("<solo@x.test>")
    expect(threadKeyOf({ messageId: "  " }, undefined, members({}))).toBeNull()
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
