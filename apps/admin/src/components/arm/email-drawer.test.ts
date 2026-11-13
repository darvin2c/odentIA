import { describe, expect, it } from "vitest"
import { inboundEmailSchema } from "./email-drawer"
import { type KairosItem, kairosItemSchema, newClientFromEmail } from "./kairos-items"

/** Un correo como lo devuelve `GET /api/admin/clients/inbound/:emailId`. */
const email = {
  id: "e1",
  mailbox: "hola",
  product: "dental",
  from: "elena@example.test",
  fromName: "Elena Quispe",
  to: "hola@odentia32.com",
  subject: "¿Cómo empiezo?",
  text: "Hola",
  receivedAt: "2026-11-13T15:00:00.000Z",
  senderVerified: true,
  attachments: 2,
  clientId: null,
  matchedBy: null,
  staff: null,
  canReply: true,
  replyFrom: { name: "Ada Lovelace · odentIA", address: "ada.lovelace@odentia32.com" },
  replySubject: "Re: ¿Cómo empiezo?",
  replies: [
    {
      id: "o1",
      status: "incierto",
      from: "ada.lovelace@odentia32.com",
      subject: "Re: ¿Cómo empiezo?",
      body: "Hola, Elena",
      createdBy: "u1",
      createdAt: "2026-11-13T16:00:00.000Z",
      sentAt: null,
    },
  ],
}

const item = (payload: Record<string, unknown>): KairosItem =>
  kairosItemSchema.parse({
    id: "k1",
    clientId: null,
    clientName: null,
    product: null,
    kind: "correo_sin_cliente",
    title: "Correo sin cliente: Elena Quispe",
    reason: "Llegó a hola@",
    status: "espera",
    payload,
    ready: true,
    adminOnly: false,
    expiresAt: "2026-11-15T15:00:00.000Z",
    createdAt: "2026-11-13T15:00:00.000Z",
    decidedAt: null,
    decidedByName: null,
    result: null,
    error: null,
  })

describe("el correo que llegó", () => {
  it("se lee como lo manda el servidor; sin «Desde» (quien ya no está) queda nulo", () => {
    const read = inboundEmailSchema.parse(email)
    expect(read.replyFrom?.address).toBe("ada.lovelace@odentia32.com")
    expect(read.replies[0]?.status).toBe("incierto")
    const { replyFrom: _from, replySubject: _subject, ...older } = email
    expect(inboundEmailSchema.parse(older)).toMatchObject({ replyFrom: null, replySubject: "" })
  })

  it("«Crear cliente con este correo» trae quién escribió, su correo y la marca", () => {
    expect(
      newClientFromEmail(
        item({
          emailId: "e1",
          mailbox: "hola",
          product: "medical",
          from: "elena@example.test",
          fromName: "Elena Quispe",
        }),
      ),
    ).toEqual({
      contactName: "Elena Quispe",
      email: "elena@example.test",
      product: "medical",
      origin: "otro",
      originDetail: "Nos escribió a hola@",
    })
    // A la dirección de una persona y sin nombre: no se inventa nada.
    expect(
      newClientFromEmail(item({ emailId: "e2", mailbox: "persona", from: "x@example.test" })),
    ).toEqual({
      contactName: "",
      email: "x@example.test",
      origin: "otro",
      originDetail: "Nos escribió a una persona del equipo",
    })
  })
})
