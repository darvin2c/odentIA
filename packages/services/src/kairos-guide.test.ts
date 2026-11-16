import { describe, expect, it } from "vitest"
import type { HelpDecider } from "./help-decision.js"
import { askGuideForSale } from "./kairos-guide.js"
import { helpTopicsFor } from "./products.js"

/** Una pregunta escrita igual que en la guía de odentIA (la primera con preguntas frecuentes). */
function exactQuestion(): string {
  const topic = helpTopicsFor("dental").find((t) => (t.faqs ?? []).length > 0)
  const q = topic?.faqs?.[0]?.q
  if (!q) throw new Error("La guía de odentIA no tiene preguntas frecuentes")
  return q
}

describe("Kairós le pregunta a Ariadna (la guía de la Ayuda)", () => {
  it("lo escrito igual que en la guía responde sin modelo", async () => {
    const answer = await askGuideForSale("dental", exactQuestion(), null)
    expect(answer.found).toBe(true)
    if (answer.found) expect(answer.texts[0]?.length).toBeGreaterThan(10)
  })

  it("sin Jev, lo demás no se afirma", async () => {
    const answer = await askGuideForSale("dental", "¿emite facturas electrónicas a la SUNAT?", null)
    expect(answer).toEqual({ found: false, why: "sin_guia" })
  })

  it("si Jev falla, tampoco se afirma nada", async () => {
    const broken: HelpDecider = {
      decide: async () => {
        throw new Error("Jev caído")
      },
    } as unknown as HelpDecider
    const answer = await askGuideForSale("dental", "¿tiene odontograma para niños?", broken)
    expect(answer.found).toBe(false)
    // Aunque las palabras calcen con una respuesta de la guía: sin Jev no se afirma.
    const words = await askGuideForSale(
      "dental",
      "¿se puede firmar el consentimiento en la tablet?",
      broken,
    )
    expect(words.found).toBe(false)
  })

  it("una pregunta vacía no busca", async () => {
    expect(await askGuideForSale("optical", "   ", null)).toEqual({ found: false, why: "no_esta" })
  })
})
