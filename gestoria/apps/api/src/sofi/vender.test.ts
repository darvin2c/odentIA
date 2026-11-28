/**
 * Cómo vende Sofi (tablero 21), sin base: la oferta llega una sola vez, no se mejora, vence a la
 * hora que le dijo y nunca va con pago al recibir; lo que sabe de la clienta para elegir qué
 * ofrecer, y lo que no puede decir para vender («hablé con la tienda», «te la separo»).
 */
import { describe, expect, it } from "vitest"
import { questionKey } from "../preguntas.js"
import { dateWords, statusWords, valueText } from "./ficha.js"
import { offeredIn, offerProblem, usedIn } from "./herramientas.js"
import { claimsInvented } from "./revisar.js"
import { customerStory, offerOf } from "./sofi.js"

const now = new Date("2026-11-26T20:00:00Z")
const tomorrow = new Date(now.getTime() + 86_400_000)
const negotiated = (marginUsedCents: number) => ({ negotiated: true, marginUsedCents })

describe("la oferta de Sofi", () => {
  it("sin negociar no hay nada que frenar, ni con pago al recibir", () => {
    expect(offerProblem(null, now, { negotiated: false, marginUsedCents: 0 }, "al_recibir")).toBe(
      null,
    )
  })

  it("la primera oferta se puede hacer con link o captura, pero no con pago al recibir", () => {
    expect(offerProblem(null, now, negotiated(1000), "link")).toBeNull()
    expect(offerProblem(null, now, negotiated(1000), "comprobante")).toBeNull()
    expect(offerProblem(null, now, negotiated(1000), "al_recibir")).toContain("pago al recibir")
  })

  it("una sola vez: si insiste, la misma o una que ceda menos, nunca más", () => {
    const offer = { cededCents: 1000, expiresAt: tomorrow }
    // Ana eligió el envío gratis en vez de S/ 10 menos: cede lo mismo.
    expect(offerProblem(offer, now, negotiated(1000), "link")).toBeNull()
    expect(offerProblem(offer, now, negotiated(500), "link")).toBeNull()
    expect(offerProblem(offer, now, negotiated(1500), "link")).toContain("no se mejora")
  })

  it("vencido el plazo, no se renueva sola", () => {
    const offer = { cededCents: 1000, expiresAt: new Date(now.getTime() - 60_000) }
    expect(offerProblem(offer, now, negotiated(1000), "link")).toContain("venció")
  })

  it("se lee de sus respuestas: lo más que cedió y el plazo de la primera vez", () => {
    const first = new Date("2026-11-27T23:40:00Z")
    expect(offerOf([])).toBeNull()
    expect(
      offerOf([
        { tools: [] },
        { oferta: { cedido: 1000, vence: first.toISOString() } },
        { oferta: { cedido: 500, vence: "2026-11-28T10:00:00Z" } },
        { oferta: { cedido: "mucho" } },
      ]),
    ).toEqual({ cededCents: 1000, expiresAt: first })
  })
})

describe("lo que sabe de la clienta", () => {
  const day = 86_400_000
  const order = (state: string, daysAgo: number, marginUsedCents = 0, test = false) => ({
    state,
    createdAt: new Date(now.getTime() - daysAgo * day),
    marginUsedCents,
    test,
  })

  it("primera compra: lo que no se pagó o se anuló no cuenta", () => {
    expect(customerStory([], now, false)).toContain("Primera compra")
    expect(customerStory([order("por_pagar", 0), order("anulado", 3)], now, false)).toContain(
      "Primera compra",
    )
  })

  it("compra seguido: dos compras en los últimos tres meses", () => {
    const story = customerStory([order("entregado", 35), order("entregado", 5)], now, false)
    expect(story).toContain("Ya compró 2 veces; la última, hace 5 días.")
    expect(story).toContain("Compra seguido.")
  })

  it("siempre pide rebaja: en todas sus compras se le cedió algo", () => {
    const story = customerStory(
      [order("entregado", 200, 900), order("entregado", 100, 500)],
      now,
      false,
    )
    expect(story).toContain("Siempre pide rebaja")
    expect(story).not.toContain("Compra seguido")
  })

  it("lo de prueba no cuenta en una conversación de verdad", () => {
    expect(customerStory([order("entregado", 2, 0, true)], now, false)).toContain("Primera compra")
    expect(customerStory([order("entregado", 2, 0, true)], now, true)).toContain("una vez")
  })
})

describe("lo que no dice para vender", () => {
  it("no dice que habló con la tienda ni que separa el producto", () => {
    expect(claimsInvented("Hablé con la tienda y te consiguió el envío gratis")).toBe(true)
    expect(claimsInvented("Le pregunté al dueño y te lo deja en S/ 119")).toBe(true)
    expect(claimsInvented("Mi jefa me autorizó S/ 10 menos")).toBe(true)
    expect(claimsInvented("Te la separo hasta mañana")).toBe(true)
  })

  it("«Le pregunto a la tienda y te escribo» sí: es lo que va a hacer, no algo que ya pasó", () => {
    expect(claimsInvented("No lo tengo confirmado. Le pregunto a la tienda y te escribo.")).toBe(
      false,
    )
  })

  it("«te consigo» y el plazo sí", () => {
    expect(
      claimsInvented(
        "Te consigo el envío gratis o S/ 10 menos, tú eliges, si lo pagas hasta mañana",
      ),
    ).toBe(false)
    expect(claimsInvented("Una persona del equipo revisa tu captura y te aviso")).toBe(false)
  })
})

describe("lo que le ofreció en un turno", () => {
  const trace = {
    offers: [
      { totalCents: 12900, cededCents: 1000 },
      { totalCents: 10900, cededCents: 3000 },
    ],
  }

  it("cuenta lo que dijo, no lo que solo probó con cotizar", () => {
    expect(offeredIn(trace, [12900])).toBe(1000)
    expect(offeredIn(trace, [12900, 10900])).toBe(3000)
  })

  it("sin un total dicho, cuenta lo que menos cede; sin negociar, nada", () => {
    expect(offeredIn(trace, [1000])).toBe(1000)
    expect(offeredIn({ offers: [] }, [12900])).toBeNull()
  })
})

describe("lo que lee de la ficha", () => {
  it("cada dato del rubro en palabras, con su unidad", () => {
    expect(
      valueText({ key: "horma", label: "Cómo calza", type: "opcion", needed: true }, "Normal"),
    ).toBe("Normal")
    expect(
      valueText(
        {
          key: "plantilla",
          label: "Largo de la plantilla",
          type: "por_talla",
          unit: "cm",
          needed: false,
        },
        { "37": 23.5, "38": 24 },
      ),
    ).toBe("37: 23,5 cm; 38: 24 cm")
    expect(
      valueText(
        {
          key: "medidas",
          label: "Medidas",
          type: "tabla",
          columns: ["Pecho", "Largo"],
          unit: "cm",
          needed: true,
        },
        { M: [50, null] },
      ),
    ).toBe("M: Pecho 50 cm")
    expect(
      valueText({ key: "x", label: "X", type: "texto", needed: false }, { noAplica: true }),
    ).toBe("No aplica")
    expect(valueText({ key: "x", label: "X", type: "texto", needed: false }, undefined)).toBeNull()
    expect(dateWords("2026-12-05")).toBe("5 de diciembre")
    expect(dateWords("2028-06")).toBe("junio de 2028")
  })

  it("cada estado con lo que dice Sofi; disponible no dice nada", () => {
    const row = { status: null, statusDays: null, statusPerDay: null, statusDate: null }
    expect(statusWords(row)).toBeNull()
    expect(statusWords({ ...row, status: "encargo", statusDays: 5 })).toContain(
      "te la consigo en 5 días",
    )
    expect(statusWords({ ...row, status: "cupo", statusPerDay: 3 })).toContain(
      "No confirmes que hay cupo",
    )
    expect(statusWords({ ...row, status: "preventa", statusDate: "2026-12-05" })).toContain(
      "Llega el 5 de diciembre",
    )
    expect(statusWords({ ...row, status: "liquidacion" })).toContain("precio final")
  })

  it("qué usó: lo que leyó y está en lo que escribió", () => {
    const facts = [
      { label: "Cómo calza: normal", target: "datos", words: ["normal"] },
      { label: "Stock negra 38: 2", target: "stock", words: ["negra", "38", "2"] },
      { label: "Stock blanca 38: 0", target: "stock", words: ["blanca", "38", "0"] },
      { label: "Foto de «negra»", target: "fotos", words: [] },
    ]
    expect(usedIn({ facts }, "Calza normal. La negra 38: me quedan 2.")).toEqual([
      { label: "Cómo calza: normal", target: "datos" },
      { label: "Stock negra 38: 2", target: "stock" },
      { label: "Foto de «negra»", target: "fotos" },
    ])
  })

  it("dos preguntas iguales, sin tildes ni signos, son una sola", () => {
    expect(questionKey("¿Destiñe al lavarla?")).toBe(questionKey("destine al lavarla"))
    expect(questionKey("¿Destiñe?")).not.toBe(questionKey("¿Se encoge?"))
  })
})
