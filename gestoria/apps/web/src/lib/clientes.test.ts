import { describe, expect, it } from "vitest"
import {
  type CustomerHistoryItem,
  channelsText,
  historyText,
  purchasesText,
  reasonText,
  sinceText,
  whatsappLink,
} from "./clientes"

const item = (over: Partial<CustomerHistoryItem>): CustomerHistoryItem => ({
  id: "e1",
  action: "unida",
  createdAt: "2026-11-26T14:40:00Z",
  actorName: "Lucía Torres",
  self: false,
  with: { id: "c2", name: "Mari R." },
  separates: "c2",
  ...over,
})

describe("cómo se dice una clienta", () => {
  it("sus canales, sin «otro»", () => {
    expect(channelsText(["whatsapp", "instagram", "otro"])).toBe("WhatsApp · Instagram")
    expect(channelsText([])).toBe("")
  })

  it("sus compras, con el día de la última", () => {
    expect(purchasesText(0, null, "2026-11-26")).toBe("Sin compras")
    expect(purchasesText(1, "2026-11-26T15:00:00", "2026-11-26")).toBe("1 compra · la última hoy")
    expect(purchasesText(3, "2026-11-25T15:00:00", "2026-11-26")).toBe("3 compras · la última ayer")
  })

  it("desde cuándo es clienta, sin puntos ni «de»", () => {
    expect(sinceText("2026-10-10T15:00:00")).toBe("clienta desde oct 2026")
  })

  it("escribirle por WhatsApp solo con el código del país, que lo envía la persona", () => {
    expect(whatsappLink(["987 654 321", "+51 987 654 321"])).toBe("https://wa.me/51987654321")
    expect(whatsappLink(["987 654 321"])).toBeNull()
    expect(whatsappLink([])).toBeNull()
  })

  it("por qué se sugiere que son la misma", () => {
    expect(reasonText("telefono")).toBe("Tienen el mismo teléfono.")
    expect(reasonText("nombre")).toBe("Tienen el mismo nombre.")
  })

  it("lo que decidió el equipo, desde la ficha que se ve", () => {
    expect(historyText(item({}))).toBe(
      "Lucía Torres dijo que «Mari R.» es la misma clienta: su ficha quedó dentro de esta.",
    )
    expect(historyText(item({ self: true, with: { id: "c1", name: "Mariela Ríos" } }))).toBe(
      "Lucía Torres dijo que esta ficha es la misma clienta que «Mariela Ríos».",
    )
    expect(historyText(item({ action: "separada" }))).toBe(
      "Lucía Torres separó «Mari R.»: volvió a ser otra ficha.",
    )
    expect(historyText(item({ action: "separada", self: true }))).toBe(
      "Lucía Torres separó esta ficha de «Mari R.».",
    )
    expect(historyText(item({ action: "distintas", actorName: null }))).toBe(
      "Alguien del equipo dijo que «Mari R.» es otra clienta.",
    )
  })
})
