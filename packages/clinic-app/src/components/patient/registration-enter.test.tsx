// @vitest-environment jsdom

import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { RegistrationQuestionnaire } from "./registration-questionnaire"

declareProduct(bareProduct("dental"))

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView ??= () => {}
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

/** «Tus datos y tu salud» del enlace, cuando solo falta su salud. */
function healthOnly(onSubmit = vi.fn(async () => {})) {
  render(
    <RegistrationQuestionnaire
      config={DEFAULT_REGISTRATION_CONFIG}
      today="2026-11-14"
      countryCode="PE"
      fill={{ missing: new Set(), health: true, hasRepresentative: false, firstName: "Rosa" }}
      onSubmit={onSubmit}
    />,
  )
  return onSubmit
}

const enter = (target: Element) => fireEvent.keyDown(target, { key: "Enter" })

/** El grupo de una pregunta de botones (Sí, No, No sé) por su pregunta. */
function question(name: RegExp): HTMLElement {
  const found = screen.getAllByRole("group", { name }).find((group) => group.querySelector("button"))
  if (!found) throw new Error(`Sin la pregunta ${name}`)
  return found
}

const answer = (name: RegExp, text: string) => {
  const button = [...question(name).querySelectorAll("button")].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`Sin «${text}» en ${name}`)
  fireEvent.click(button)
}

/** Si una opción quedó elegida en el grupo: Enter nunca contesta por la persona. */
const answered = (name: RegExp) =>
  [...question(name).querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || b.dataset.state === "on",
  )

// QA de la entrega 3 (14 nov): en «Tus datos y tu salud», Enter en «¿A qué?» de la alergia saltaba
// a la pantalla siguiente y dejaba sin ver «¿Tienes alguna enfermedad?» y la medicación. Desde la
// entrega 6, después de «¿A qué?» viene «¿Qué te pasó?», y después las enfermedades de la lista.
it("Enter en la respuesta de la alergia pasa a la pregunta siguiente, sin cambiar de pantalla", async () => {
  healthOnly()
  await screen.findAllByRole("group", { name: /alergia a algún medicamento o material/ })
  answer(/algún medicamento o material/, "Sí")
  const what = await screen.findByLabelText(/¿A qué\?/)
  fireEvent.change(what, { target: { value: "penicilina" } })
  enter(what)
  expect(document.activeElement).toBe(screen.getByLabelText("¿Qué te pasó?"))
  enter(document.activeElement as Element)
  expect(question(/alguna de estas enfermedades/).contains(document.activeElement)).toBe(true)
  expect(screen.getByLabelText(/¿A qué\?/)).toBeTruthy()
})

/** Enter como lo hace el navegador: si nadie lo detuvo, un botón con el foco se pulsa. */
function enterLikeBrowser(target: Element) {
  if (fireEvent.keyDown(target, { key: "Enter" }) && target instanceof HTMLButtonElement) fireEvent.click(target)
}

// Verificación de la entrega 3 (14 nov): tras «¿A qué?», el primer Enter llevaba el foco al «No» de la
// enfermedad sin marcarlo, pero el segundo lo marcaba: «niega enfermedades» sin que lo dijera.
it("Enter repetido después de «¿A qué?» recorre las preguntas sin contestar ninguna", async () => {
  healthOnly()
  await screen.findAllByRole("group", { name: /alergia a algún medicamento o material/ })
  answer(/algún medicamento o material/, "Sí")
  const what = await screen.findByLabelText(/¿A qué\?/)
  fireEvent.change(what, { target: { value: "penicilina" } })
  enterLikeBrowser(what)
  // «¿Qué te pasó?», las enfermedades, el corazón, el antibiótico y la anestesia: hasta el grupo sanguíneo.
  for (let i = 0; i < 6; i++) enterLikeBrowser(document.activeElement as Element)
  expect((document.activeElement as HTMLElement | null)?.dataset.slot).toBe("select-trigger")
  for (const name of [/alguna de estas enfermedades/, /válvula del corazón/, /antibiótico antes de ir al dentista/, /problema con la anestesia/]) {
    expect(answered(name), String(name)).toEqual([])
  }
})

// …y en la última pantalla, Enter en la última respuesta escrita lo enviaba todo. Desde la entrega 6,
// lo que toma va en su propio paso, «Tus medicinas», que termina en «¿Tomas algún otro medicamento…?».
it("Enter nunca envía: en la última respuesta lleva al botón, sin pulsarlo", async () => {
  const onSubmit = healthOnly()
  await screen.findAllByRole("group", { name: /alergia a algún medicamento o material/ })
  answer(/algún medicamento o material/, "No")
  answer(/alguna de estas enfermedades/, "No")
  answer(/válvula del corazón/, "No")
  answer(/problema con la anestesia/, "No")
  fireEvent.click(screen.getByRole("button", { name: "Siguiente" }))
  await screen.findAllByRole("group", { name: /coágulos/ }, { timeout: 5000 })
  answer(/coágulos/, "No")
  answer(/medicinas para los huesos/, "No")
  answer(/algún otro medicamento todos los días/, "Sí")
  const which = (await screen.findAllByLabelText(/¿Cuál\? Si son varios/)).at(-1) as HTMLInputElement
  fireEvent.change(which, { target: { value: "Losartán" } })
  enter(which)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(onSubmit).not.toHaveBeenCalled()
  // El foco pasa al botón de seguir, sin pulsarlo, y nunca a «Anterior» ni a «Saltar».
  expect((document.activeElement as HTMLElement | null)?.dataset.slot).toBe("questionnaire-next")
  const stops = [...document.querySelectorAll<HTMLElement>("[data-slot=questionnaire-previous], [data-slot=questionnaire-skip]")]
  expect(stops.length).toBeGreaterThan(0)
  for (const stop of stops) expect(stop.hasAttribute("data-enter-skip")).toBe(true)
  // Recorre dos pasos del cuestionario: con todo el paquete corriendo a la vez pasa de los 5 s.
}, 20_000)
