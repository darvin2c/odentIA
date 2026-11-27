/**
 * Lo que dicen los papeles enviados por mensaje (pedido del 27 nov): el consentimiento por
 * firmar decía «Lo tiene en su enlace» y la receta «Ya se le envió» aunque WhatsApp no los
 * entregara. Dicen lo que pasó con su mensaje, como el presupuesto.
 */
import { describe, expect, it } from "vitest"
import type { MessageDelivery } from "../../lib/message-delivery"
import { consentLinkWords } from "./consent-link-actions"
import { sentWarningWords } from "./document-papers"

const failed: MessageDelivery = {
  state: "no_llego",
  channel: "whatsapp",
  at: "2026-11-27T15:00:00.000Z",
  text: "No llegó por WhatsApp · enviado el 27 nov",
  reason: "Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica.",
  problem:
    "Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica. Corrige su número en sus Datos y vuelve a enviárselo con «Enviarlo por mensaje», o muéstraselo para que lo firme en su teléfono.",
}
const pending: MessageDelivery = { ...failed, state: "enviado", text: "Enviado por WhatsApp el 27 nov", reason: null, problem: null }

describe("consentimiento enviado a firmar", () => {
  const sent = { status: "pendiente" as const, linkSentAt: "2026-11-27T15:00:00.000Z", personSignedAt: null }
  it("si no le llegó, por qué y qué hacer; nunca «Lo tiene en su enlace»", () => {
    const words = consentLinkWords({ ...sent, linkDelivery: failed })
    expect(words).toBe(`No llegó por WhatsApp · enviado el 27 nov. ${failed.problem}`)
    expect(words).not.toContain("Lo tiene en su enlace")
  })
  it("mientras WhatsApp no confirma, «Enviado…»", () => {
    expect(consentLinkWords({ ...sent, linkDelivery: pending })).toBe("Enviado por WhatsApp el 27 nov: espera su firma.")
  })
})

describe("receta enviada, al anularla", () => {
  const last = { at: "2026-11-27T15:00:00.000Z", channel: "whatsapp", recipientName: "Ana" }
  it("si no le llegó, lo dice con el motivo y que no hace falta avisarle", () => {
    expect(sentWarningWords({ ...last, delivery: failed })).toBe(
      `No llegó por WhatsApp · enviado el 27 nov a Ana. ${failed.reason} No hace falta avisarle: no la tiene en su chat.`,
    )
  })
  it("con su acuse, «Entregado…» y que avise", () => {
    expect(sentWarningWords({ ...last, delivery: { ...pending, state: "entregado", text: "Entregado por WhatsApp · enviado el 27 nov" } })).toBe(
      "Entregado por WhatsApp · enviado el 27 nov a Ana: avísale que no la use.",
    )
  })
})
