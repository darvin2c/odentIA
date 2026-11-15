// @vitest-environment jsdom

import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { setFormatRegion } from "@odentia/ui-patterns"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { RegistrationQuestionnaire } from "./registration-questionnaire"

declareProduct(bareProduct("dental"))

beforeAll(() => {
  setFormatRegion({ locale: "es-PE", timeZone: "America/Lima" })
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

// QA de la entrega 3 (14 nov): con «31/02/1990», el campo decía «Ese mes tiene 28 días» y, al pasar
// de paso, salía además «Revisa la fecha: escribe día, mes y año.», aunque los había escrito.
it("una fecha que no existe se dice una sola vez, con lo que hay que arreglar", async () => {
  render(
    <RegistrationQuestionnaire
      config={DEFAULT_REGISTRATION_CONFIG}
      today="2026-11-14"
      countryCode="PE"
      fill={{ missing: new Set(["birthDate"]), health: false, hasRepresentative: false, firstName: "Rosa" }}
      onSubmit={async () => {}}
    />,
  )
  const birth = await screen.findByLabelText(/Fecha de nacimiento/)
  fireEvent.change(birth, { target: { value: "31/02/1990" } })
  expect(screen.getAllByText(/Ese mes tiene 28 días/)).toHaveLength(1)
  const step = birth.closest("[data-slot=questionnaire-item]") ?? document
  const next = step.querySelector<HTMLElement>(
    "[data-slot=questionnaire-next]:not([hidden]), [data-slot=questionnaire-submit]:not([hidden])",
  )
  fireEvent.click(next as HTMLElement)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.getAllByText(/Ese mes tiene 28 días/)).toHaveLength(1)
  expect(screen.queryByText(/Revisa la fecha: escribe día, mes y año/)).toBeNull()
})

/** «Su enlace» de una persona sin fecha en su ficha, como lo da el servidor (`asksWho`). */
function noDateLink(onSubmit: (answers: unknown) => Promise<void>) {
  render(
    <RegistrationQuestionnaire
      config={{ ...DEFAULT_REGISTRATION_CONFIG, privacyNotice: "Aviso de demostración" }}
      today="2026-11-14"
      countryCode="PE"
      fill={{
        missing: new Set(["birthDate"]),
        health: true,
        // Sin la fecha, lo de un adulto y lo de un niño: la pantalla elige con la que escribe.
        healthKeys: new Set(["allergies", "dental.quienCepilla"]),
        hasRepresentative: false,
        firstName: "Lucía",
        sex: "F",
        asksWho: true,
        privacy: true,
        clinicName: "Dental Smile",
      }}
      onSubmit={onSubmit}
    />,
  )
}

const active = () => document.querySelector<HTMLElement>("[data-slot=questionnaire-item][data-active]")
const shown = () => active()?.querySelector("[data-slot=questionnaire-title]")?.textContent
const next = () => fireEvent.click(active()?.querySelector("[data-slot=questionnaire-next]") as HTMLElement)
/** Elige una opción de un grupo de botones (Sí, No; Madre, Padre o Tutor legal) por su pregunta. */
function answer(name: RegExp, text: string) {
  const group = screen.getAllByRole("group", { name }).find((found) => found.querySelector("button"))
  const button = [...(group?.querySelectorAll("button") ?? [])].find((found) => found.textContent?.trim() === text)
  if (!button) throw new Error(`Sin «${text}» en ${name}`)
  fireEvent.click(button)
}

// K1 (revisión final de formularios; M2 de la 7): recepción registró a Lucía sin fecha, con el celular
// de su mamá. Su enlace lo pregunta primero, y desde ahí le habla a quien responde.
it("sin fecha en su ficha, el enlace pregunta «¿Eres Lucía o respondes por ella?» y le habla a la mamá", async () => {
  const onSubmit = vi.fn(async (_answers: unknown) => {})
  noDateLink(onSubmit)
  await waitFor(() => expect(shown()).toBe("¿Eres Lucía o respondes por ella?"), { timeout: 5000 })
  expect(active()?.textContent).toContain("Soy Lucía")
  // Sin elegir no sigue: nada se supone.
  next()
  expect(shown()).toBe("¿Eres Lucía o respondes por ella?")
  fireEvent.click(screen.getByLabelText(/Respondo por ella/))
  next()
  await waitFor(() => expect(shown()).toBe("Datos de quien se atenderá"), { timeout: 5000 })
  fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), { target: { value: "02/03/2023" } })
  next()
  await waitFor(() => expect(shown()).toBe("Ahora tus datos"), { timeout: 5000 })
  expect(active()?.textContent).toContain("Lucía es menor de edad: déjanos tus datos, que respondes por Lucía.")
  fireEvent.change(screen.getByLabelText("Tu nombre y apellidos"), { target: { value: "Carmen Paredes Ruiz" } })
  answer(/¿Qué eres de Lucía\?/, "Madre")
  expect(screen.getByLabelText(/Tu DNI/)).toBeTruthy()
  // Su celular y su documento: recepción la registra con ellos.
  fireEvent.change(screen.getByLabelText(/Tu DNI/), { target: { value: "42345678" } })
  const phone = active()?.querySelector<HTMLInputElement>("input[type=tel]")
  fireEvent.change(phone as HTMLInputElement, { target: { value: "955111222" } })
  next()
  await waitFor(() => expect(shown()).toBe("La salud de Lucía"), { timeout: 5000 })
  expect(active()?.textContent).toContain("Lo respondes tú, Carmen.")
  answer(/¿Lucía tiene alergia/, "No")
  next()
  // La fecha que escribió la hace niña: «Los dientes de Lucía en casa».
  await waitFor(() => expect(shown()).toBe("Los dientes de Lucía en casa"), { timeout: 5000 })
  expect(active()?.textContent).toContain("Lo respondes tú, Carmen.")
  next()
  await waitFor(() => expect(shown()).toBe("Antes de enviar"), { timeout: 5000 })
  expect(active()?.textContent).toContain("Acepto el aviso de privacidad de Dental Smile para los datos de Lucía y los míos.")
  fireEvent.click(active()?.querySelector("[role=checkbox]") as HTMLElement)
  fireEvent.click(active()?.querySelector("[data-slot=questionnaire-submit]") as HTMLElement)
  await waitFor(() => expect(onSubmit).toHaveBeenCalled(), { timeout: 5000 })
  expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
    respondent: "representative",
    representative: { displayName: "Carmen Paredes Ruiz", relationshipDetail: "Madre", docNumber: "42345678" },
    demographics: { birthDate: "2023-03-02" },
  })
}, 30_000)

it("si es ella y la fecha la hace menor, deja los datos de quien responde por ella", async () => {
  noDateLink(async () => {})
  await waitFor(() => expect(shown()).toBe("¿Eres Lucía o respondes por ella?"), { timeout: 5000 })
  fireEvent.click(screen.getByLabelText(/Soy Lucía/))
  next()
  await waitFor(() => expect(shown()).toBe("Tus datos"), { timeout: 5000 })
  fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), { target: { value: "02/03/2011" } })
  next()
  await waitFor(() => expect(shown()).toBe("Tu madre, padre o tutor"), { timeout: 5000 })
  expect(active()?.textContent).toContain("Eres menor de edad: déjanos los datos de quien responde por ti.")
}, 30_000)
