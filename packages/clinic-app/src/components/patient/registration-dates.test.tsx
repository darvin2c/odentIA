// @vitest-environment jsdom

import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { setFormatRegion } from "@odentia/ui-patterns"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, it } from "vitest"
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
