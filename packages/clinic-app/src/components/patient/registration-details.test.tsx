// @vitest-environment jsdom

import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { formDetailDescription } from "./encounter-documents"
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

const page = (missing: string[], health = false) => (
  <RegistrationQuestionnaire
    config={DEFAULT_REGISTRATION_CONFIG}
    today="2026-11-14"
    countryCode="PE"
    fill={{ missing: new Set(missing), health, hasRepresentative: false, firstName: "Rosa" }}
    onSubmit={async () => {}}
  />
)

// QA de la entrega 3 (14 nov), detalles.
describe("detalles de «Tus datos y tu salud» y del formulario", () => {
  it("el número de DNI abre el teclado de números; el pasaporte, el de letras", async () => {
    render(page(["docType", "docNumber"]))
    fireEvent.click(await screen.findByRole("button", { name: "DNI" }))
    expect((await screen.findByLabelText("Número de DNI")).getAttribute("inputmode")).toBe("numeric")
    fireEvent.click(screen.getByRole("button", { name: "Pasaporte" }))
    expect((await screen.findByLabelText(/Número de pasaporte/i)).getAttribute("inputmode")).toBeNull()
  })

  it("la alergia se pregunta sin género: «¿Eres alérgico…?» después de elegir «Femenino» no calza", () => {
    const html = renderToStaticMarkup(page([], true))
    expect(html).toContain("¿Tienes alergia a algún medicamento o material?")
    expect(html).not.toContain("alérgico")
  })

  it("un formulario finalizado ya no dice que se guarda solo", () => {
    expect(formDetailDescription({ status: "borrador" }, true)).toBe("Se guarda sola mientras la llenas.")
    expect(formDetailDescription({ status: "finalizado" }, true)).not.toMatch(/se guarda sola/i)
    expect(formDetailDescription({ status: "borrador" }, false)).toBeUndefined()
    // Lo que respondió el paciente no lo escribe el equipo: ni «se guarda solo» ni «agrega una adenda».
    expect(formDetailDescription({ status: "borrador", source: "portal" }, true)).toBeUndefined()
    expect(formDetailDescription({ status: "finalizado", source: "portal" }, true)).toBeUndefined()
  })
})
