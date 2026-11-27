import { describe, expect, it } from "vitest"
import {
  alternativeValue,
  birthdayParts,
  birthdayProblem,
  birthdayValue,
  channelsWhere,
  consentBadge,
  consentNoteText,
  consentOrigin,
  factOrigin,
  shortDate,
  stepText,
  threadOf,
} from "./perfil"

const LIMA = "America/Lima"
const TODAY = "2026-11-27"

describe("de dónde salió cada dato", () => {
  it("lo que anotó Argos dice de dónde, con el día de la tienda", () => {
    const base = { quote: null, byName: null, at: "2026-09-26T15:00:00Z" }
    expect(factOrigin({ ...base, source: "pedido" }, LIMA, TODAY)).toEqual({
      byStore: false,
      text: "Argos lo anotó de sus pedidos · 26 set",
    })
    expect(
      factOrigin(
        { ...base, source: "chat", quote: "calzo 37", at: "2026-11-20T18:00:00Z" },
        LIMA,
        TODAY,
      ).text,
    ).toBe("Argos lo anotó del chat del 20 nov: «calzo 37»")
    expect(factOrigin({ ...base, source: "respuesta" }, LIMA, TODAY).text).toBe(
      "Argos lo anotó de cómo responde · 26 set",
    )
  })

  it("lo que corrigió una persona queda suyo", () => {
    expect(
      factOrigin(
        { source: "tienda", quote: null, byName: "Lucía Torres", at: "2026-11-22T15:00:00Z" },
        LIMA,
        TODAY,
      ),
    ).toEqual({ byStore: true, text: "Lucía lo corrigió el 22 nov. Argos no lo vuelve a pisar." })
  })

  it("el día es el de la tienda, y lleva el año si no es este", () => {
    // 04:00 UTC del 1 de diciembre es todavía 30 de noviembre en Lima.
    expect(shortDate("2026-12-01T04:00:00Z", LIMA, TODAY)).toBe("30 nov")
    expect(shortDate("2025-08-12T15:00:00Z", LIMA, TODAY)).toBe("12 ago 2025")
  })

  it("cada paso del historial dice cuándo, quién y de dónde", () => {
    expect(
      stepText(
        {
          value: "37",
          source: "pedido",
          quote: null,
          orderNumber: "0147",
          byName: null,
          at: "2026-09-26T15:00:00Z",
        },
        LIMA,
        TODAY,
      ),
    ).toBe("26 set · Argos · del pedido 0147")
    expect(
      stepText(
        {
          value: "38",
          source: "tienda",
          quote: null,
          orderNumber: null,
          byName: "Lucía Torres",
          at: "2026-11-22T15:00:00Z",
        },
        LIMA,
        TODAY,
      ),
    ).toBe("22 nov · Lucía Torres · lo corrigió a mano")
  })
})

describe("el cumpleaños, sin año", () => {
  it("se lee y se envía como --MM-DD", () => {
    expect(birthdayParts("--03-14")).toEqual({ day: "14", month: "3" })
    expect(birthdayParts("")).toEqual({ day: "", month: "" })
    expect(birthdayValue("4", "3")).toBe("--03-04")
  })

  it("pide un día que exista, con el 29 de febrero", () => {
    expect(birthdayProblem("", "3")).toBe("Elige el día y el mes.")
    expect(birthdayProblem("31", "4")).toBe("abril tiene 30 días.")
    expect(birthdayProblem("29", "2")).toBeNull()
  })

  it("una alternativa se envía como se guarda", () => {
    expect(alternativeValue("cumpleanos", "12 de marzo")).toBe("--03-12")
    expect(alternativeValue("canal", "Instagram")).toBe("instagram")
    expect(alternativeValue("medida", " 38 ")).toBe("38")
  })
})

describe("cuándo se le puede escribir", () => {
  it("la insignia de cada permiso", () => {
    expect(consentBadge("si")).toEqual({ label: "Acepta", variant: "success" })
    expect(consentBadge("baja").label).toBe("Pidió que no le escriban")
    expect(consentBadge("sin_preguntar").label).toBe("Sin permiso todavía")
    expect(consentBadge("no").label).toBe("Dijo que no")
  })

  it("el permiso sale de lo que dijo ella", () => {
    expect(
      consentOrigin(
        { state: "si", quote: "sí, avísame", at: "2026-08-12T15:00:00Z", channel: "whatsapp" },
        LIMA,
        TODAY,
      ),
    ).toBe("Aceptó en el chat del 12 ago: «sí, avísame»")
    expect(
      consentOrigin({ state: "sin_preguntar", quote: null, at: null, channel: null }, LIMA),
    ).toBeNull()
  })

  it("por dónde: solo WhatsApp deja escribir primero", () => {
    expect(channelsWhere(["instagram", "whatsapp"])).toBe("WhatsApp")
    expect(channelsWhere(["instagram"])).toBe("Solo Instagram: ahí no se le puede escribir primero")
    expect(channelsWhere([])).toBeNull()
  })
})

describe("la nota de la baja en el chat", () => {
  it("dice la hora de la tienda", () => {
    expect(
      consentNoteText({ id: "n1", state: "baja", createdAt: "2026-11-27T14:48:00Z" }, LIMA, TODAY),
    ).toBe("Sofi le confirmó y anotó la baja en su ficha. Desde hoy, 09:48, no recibe promociones.")
  })

  it("va después de lo que Sofi le respondió a su mensaje", () => {
    const m = (id: string, author: string, at: string) => ({
      id,
      author,
      createdAt: `2026-11-27T14:${at}:00Z`,
    })
    const messages = [m("a", "sofi", "00"), m("b", "cliente", "48"), m("c", "sofi", "49")]
    const thread = threadOf(messages, [
      { id: "n1", state: "baja", createdAt: "2026-11-27T14:48:30Z", messageId: "b" },
    ])
    expect(thread.map((t) => (t.kind === "nota" ? t.note.id : t.message.id))).toEqual([
      "a",
      "b",
      "c",
      "n1",
    ])
  })
})
