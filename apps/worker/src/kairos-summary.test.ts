import { summaryActivityFact } from "@odentia/agent"
import { describe, expect, it } from "vitest"
import { type SummaryActivityRow, summaryActivityEntry, summaryDay } from "./kairos.js"

/**
 * «Lo que hay que saber» sin base: de la fila de la bitácora (como la trae la consulta de
 * `clientSummaryFacts`) al hecho que lee el modelo. Lo que salió por Sallca va sin su texto; lo
 * anotado a mano sigue como nota. La consulta misma la prueba `kairos.test.ts` contra Postgres.
 */
const row = (over: Partial<SummaryActivityRow>): SummaryActivityRow => ({
  id: "a-1",
  kind: "nota",
  direction: null,
  outcome: null,
  body: "Usa Excel",
  day: "2026-11-12",
  from_chat: false,
  sent: false,
  sent_subject: null,
  contact_name: null,
  ...over,
})

const fact = (over: Partial<SummaryActivityRow>) =>
  summaryActivityFact(summaryActivityEntry(row(over)))

describe("los hechos de la bitácora", () => {
  it("un correo nuestro que salió: el asunto, nunca el texto", () => {
    expect(
      fact({
        kind: "correo",
        direction: "salio",
        body: "Meta nos verificó\n\nYa puedes conectar tu WhatsApp.",
        sent: true,
        sent_subject: "Meta nos verificó",
      }),
    ).toBe("Le escribimos por correo el 12 de noviembre de 2026: «Meta nos verificó»")
  })

  it("una respuesta nuestra en una conversación cuenta como enviada aunque no se cruce el envío", () => {
    expect(
      fact({
        kind: "instagram",
        direction: "salio",
        body: "Te cuento los precios.",
        from_chat: true,
      }),
    ).toBe("Le escribimos por Instagram el 12 de noviembre de 2026")
  })

  it("lo que salió sin un envío nuestro lo anotó una persona: sigue siendo su nota", () => {
    expect(
      fact({
        kind: "correo",
        direction: "salio",
        body: "Le mandé el contrato",
        outcome: "Lo revisa",
      }),
    ).toBe("Correo del 12 de noviembre de 2026: Le mandé el contrato · quedó en: Lo revisa")
  })

  it("lo que nos escribió dice quién: un correo sin su texto, un chat con lo que escribió", () => {
    expect(
      fact({
        kind: "correo",
        direction: "entro",
        body: "Escribió a hola@: Hola",
        contact_name: "Rosa",
      }),
    ).toBe("Rosa nos escribió por correo el 12 de noviembre de 2026")
    expect(
      fact({ kind: "messenger", direction: "entro", body: "¿Tienen demo?", from_chat: true }),
    ).toBe("La clínica nos escribió por Messenger el 12 de noviembre de 2026: «¿Tienen demo?»")
  })

  it("el día va en palabras", () => {
    expect(summaryDay("2026-11-12")).toBe("12 de noviembre de 2026")
    expect(fact({})).toBe("Nota del 12 de noviembre de 2026: Usa Excel")
  })
})
