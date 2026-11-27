/**
 * Cómo vende Sofi (tablero 21), sin base: la oferta llega una sola vez, no se mejora, vence a la
 * hora que le dijo y nunca va con pago al recibir; lo que sabe de la clienta para elegir qué
 * ofrecer, y lo que no puede decir para vender («hablé con la tienda», «te la separo»).
 */
import { describe, expect, it } from "vitest"
import { offerProblem } from "./herramientas.js"
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

  it("«te consigo» y el plazo sí", () => {
    expect(
      claimsInvented(
        "Te consigo el envío gratis o S/ 10 menos, tú eliges, si lo pagas hasta mañana",
      ),
    ).toBe(false)
    expect(claimsInvented("Una persona del equipo revisa tu captura y te aviso")).toBe(false)
  })
})
