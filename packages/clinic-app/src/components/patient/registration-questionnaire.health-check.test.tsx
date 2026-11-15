// @vitest-environment jsdom
import { DEFAULT_REGISTRATION_CONFIG, type RegistrationAnswers } from "@odentia/clinical"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { type RegistrationFill, RegistrationQuestionnaire } from "./registration-questionnaire"

// Revisión final de formularios (15 nov): «¿Cambió algo?» va dentro del recorrido, después de saber
// quién responde; «Sí, cambió» pregunta «¿Qué cambió?» y solo se muestra eso (D3); «Tu visita»
// pregunta si empezó o dejó una medicina (D1). El cuestionario de verdad, en un navegador de prueba.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const config = { ...DEFAULT_REGISTRATION_CONFIG, enabled: true, privacyNotice: "Aviso de demostración" }
const SINCE = "2026-10-01T15:00:00.000Z"
const QUESTIONS = ["allergies", "conditions", "anticoagulants", "boneMedicines", "medications"] as const
type Sent = { answers: RegistrationAnswers; extra: { healthCheck?: string | null; medicinesChanged?: boolean } }
const mounted: Array<{ host: HTMLElement; root: Root }> = []

async function open(fill: RegistrationFill, sent: Sent[]) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(
      <RegistrationQuestionnaire
        config={config}
        today="2026-11-15"
        countryCode="PE"
        fill={fill}
        submitLabel="Enviar"
        shortcuts={false}
        onSubmit={async (answers, extra) => {
          sent.push({ answers, extra })
        }}
      />,
    )
  })
  return host
}

/** Lo que se ve: lo de la pantalla abierta, sin lo oculto. */
const visible = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>("[data-slot=questionnaire-item]")].find((item) => !item.hidden && !item.closest("[hidden]"))
const button = (host: HTMLElement, label: string) =>
  [...(visible(host)?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label && !item.hidden && !item.closest("[hidden]"))
const option = (host: HTMLElement, field: string, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(`[data-field="${field}"] button`)].find((item) => item.textContent === label)

async function press(element: Element | null | undefined) {
  if (!element) throw new Error("No está en la pantalla")
  await act(async () => (element as HTMLElement).click())
  await act(async () => new Promise((done) => setTimeout(done, 20)))
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("Falta el campo")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const base: RegistrationFill = {
  missing: new Set(),
  health: false,
  healthKeys: new Set(),
  hasRepresentative: true,
  firstName: "Marta",
  age: 66,
  sex: "F",
  healthCheck: { since: SINCE, questions: QUESTIONS },
}

beforeEach(() => declareProduct(bareProduct("dental")))

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
})

describe("¿Cambió algo? dentro del recorrido", () => {
  it("«No, sigue igual» es el botón principal y, sin nada más por responder, envía en ese toque", async () => {
    const sent: Sent[] = []
    const host = await open(base, sent)
    expect(visible(host)?.textContent).toContain("¿Cambió algo en tu salud o en tus medicinas desde tu última visita (1 oct)?")
    const no = button(host, "No, sigue igual")
    const yes = button(host, "Sí, cambió")
    expect(no?.getAttribute("data-variant") ?? "default").toBe("default")
    expect(yes?.className).toContain("border")
    await press(no)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.extra.healthCheck).toBe("sin_cambios")
    expect(sent[0]?.answers.health).toBeUndefined()
  })

  it("«Sí, cambió» pregunta «¿Qué cambió?» y solo muestra lo elegido: sus medicinas, sin las alergias", async () => {
    const sent: Sent[] = []
    const host = await open(base, sent)
    await press(button(host, "Sí, cambió"))
    expect(visible(host)?.textContent).toContain("¿Qué cambió?")
    // Sin elegir nada, no sigue: lo dice junto a la pregunta.
    await press(button(host, "Enviar") ?? button(host, "Siguiente"))
    expect(sent).toHaveLength(0)
    expect(visible(host)?.textContent).toContain("Elige qué cambió.")
    await press(option(host, "changeTopics", "Mis medicinas"))
    await press(button(host, "Siguiente"))
    expect(visible(host)?.textContent).toContain("Tus medicinas")
    expect(host.textContent).not.toContain("¿Tienes alergia")
    await press(option(host, "anticoagulants", "Sí"))
    await type(host.querySelector<HTMLInputElement>('[data-field="anticoagulants"] input[aria-label]'), "Apixabán 5 mg")
    await press(button(host, "Enviar"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.extra.healthCheck).toBe("cambio")
    expect(sent[0]?.answers.health?.anticoagulants).toEqual({ state: "recorded", detail: "Apixabán 5 mg" })
    expect(sent[0]?.answers.health?.allergies).toBeUndefined()
  })

  it("si la ficha no dice que sea mayor, primero quién responde: la mamá dice «No, sigue igual» por Lucía, con su nombre", async () => {
    const sent: Sent[] = []
    const host = await open({ ...base, firstName: "Lucía", age: null, asksWho: true }, sent)
    expect(visible(host)?.textContent).toContain("¿Eres Lucía o respondes por ella?")
    await press(host.querySelector('input[value="representative"]'))
    await press(button(host, "Siguiente"))
    await type(host.querySelector<HTMLInputElement>('[data-field="repName"] input'), "Carmen Ríos")
    await press(option(host, "repRelation", "Madre"))
    await press(button(host, "Siguiente"))
    expect(visible(host)?.textContent).toContain("¿Cambió algo en la salud o en las medicinas de Lucía desde su última visita (1 oct)?")
    await press(button(host, "Sí, cambió"))
    expect(option(host, "changeTopics", "Sus medicinas")).toBeDefined()
    await press(button(host, "No, sigue igual"))
    await press(button(host, "No, sigue igual"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.extra.healthCheck).toBe("sin_cambios")
    expect(sent[0]?.answers.respondent).toBe("representative")
    expect(sent[0]?.answers.representative).toMatchObject({ displayName: "Carmen Ríos", relationshipDetail: "Madre" })
  })
})

describe("¿Empezaste o dejaste alguna medicina? en «Tu visita»", () => {
  const visit: RegistrationFill = {
    ...base,
    healthCheck: null,
    visit: { purpose: null, questions: { reason: true, pain: true, more: true }, reader: "la Dra. Díaz" },
    medicineQuestions: ["anticoagulants", "boneMedicines", "medications"],
  }

  it("con «Sí», sus medicinas van en el paso siguiente y llegan con lo de su visita", async () => {
    const sent: Sent[] = []
    const host = await open(visit, sent)
    expect(visible(host)?.textContent).toContain("¿Empezaste o dejaste alguna medicina desde tu última visita?")
    await press(option(host, "visitMedicines", "Sí"))
    await press(button(host, "Siguiente"))
    expect(visible(host)?.textContent).toContain("Tus medicinas")
    await press(option(host, "anticoagulants", "Sí"))
    await press(button(host, "Enviar"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.extra.medicinesChanged).toBe(true)
    expect(sent[0]?.answers.health?.anticoagulants).toMatchObject({ state: "recorded" })
  })

  it("con «No», no hay paso de medicinas y se envía desde «Tu visita»", async () => {
    const sent: Sent[] = []
    const host = await open(visit, sent)
    await press(option(host, "visitMedicines", "No"))
    await press(button(host, "Enviar"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.extra.medicinesChanged).toBe(false)
    expect(sent[0]?.answers.health).toBeUndefined()
  })
})
