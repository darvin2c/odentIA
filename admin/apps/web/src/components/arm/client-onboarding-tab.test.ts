import { describe, expect, it } from "vitest"
import {
  canConfirmNotApplicable,
  NOT_APPLICABLE_MAX,
  onboardingHeading,
  onboardingSchema,
  stepDetailWords,
} from "./client-onboarding-tab"

const base = {
  clientId: "c1",
  organizationId: "o1",
  done: 7,
  total: 10,
  notApplicable: 1,
  next: "whatsapp",
}

describe("Ficha › Alta: «No aplica»", () => {
  it("un paso que no aplica dice su motivo, quién lo marcó y cuándo", () => {
    const data = onboardingSchema.parse({
      ...base,
      steps: [
        {
          key: "equipo",
          label: "Equipo dentro",
          state: "no_aplica",
          doneAt: null,
          detail: "No aplica: Trabaja sola",
          waitingOn: null,
          notApplicable: { reason: "Trabaja sola", by: "Ada", at: "2026-11-03T15:00:00.000Z" },
          canMarkNotApplicable: true,
        },
      ],
    })
    const [step] = data.steps
    if (!step) throw new Error("sin paso")
    expect(stepDetailWords(step)).toMatch(/^No aplica: Trabaja sola · lo marcó Ada el mar 3 nov$/)
    expect(onboardingHeading(data)).toBe("Pasos del alta · 7 de 10 · 1 no aplica")
    expect(onboardingHeading({ done: 3, total: 11, notApplicable: 0 })).toBe(
      "Pasos del alta · 3 de 11",
    )
  })

  it("un estado que la pestaña no conoce se lee como «falta» y el detalle es el del servidor", () => {
    const data = onboardingSchema.parse({
      ...base,
      steps: [
        {
          key: "whatsapp",
          label: "Espera a Meta",
          state: "otro",
          doneAt: null,
          detail: "Meta todavía no lo aprueba",
        },
      ],
    })
    expect(data.steps[0]?.state).toBe("falta")
    expect(data.steps[0] && stepDetailWords(data.steps[0])).toBe("Meta todavía no lo aprueba")
  })

  it("el diálogo no confirma con el motivo vacío ni con uno de más", () => {
    expect(canConfirmNotApplicable("")).toBe(false)
    expect(canConfirmNotApplicable("   ")).toBe(false)
    expect(canConfirmNotApplicable("Trabaja sola")).toBe(true)
    expect(canConfirmNotApplicable("x".repeat(NOT_APPLICABLE_MAX))).toBe(true)
    expect(canConfirmNotApplicable("x".repeat(NOT_APPLICABLE_MAX + 1))).toBe(false)
  })
})
