// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import type { LinkConsent } from "../../lib/booking-link"
import { bareProduct, declareProduct } from "../../product/product-ui"

declareProduct(bareProduct("dental"))

const sign = vi.hoisted(() => vi.fn())
const consent: LinkConsent = {
  id: "c1",
  title: "Consentimiento para exodoncia",
  procedureRef: null,
  diagnosis: null,
  sections: null,
  body: "Se extrae la pieza 38.",
  declaration: "Declaro que entendí lo que me explicaron.",
  signatureWords: "Firma del paciente",
  signatureNote: "",
  clinic: { name: "Dental Smile", fiscalLine: null, logo: null, branchName: null, address: null, phone: null },
  patient: { name: "Rosa Quispe", chartNumber: "HC-000001" },
  minor: false,
  signer: { name: "Rosa Quispe", asRepresentative: false, documentLabel: "DNI" },
  signable: true,
  why: null,
  speaksTo: "paciente",
  patientFirstName: "Rosa",
  appointment: null,
}
vi.mock("../../lib/booking-link", async (original) => ({
  ...(await original<typeof import("../../lib/booking-link")>()),
  fetchLinkConsent: async () => ({ data: consent }),
  signLinkConsent: sign,
}))

const { LinkConsentStep } = await import("./link-steps")

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
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
  sign.mockReset()
})

// QA de la entrega 3 (14 nov): Enter en el DNI disparaba «Firmar» y marcaba en rojo la firma antes de
// que la persona llegara a ella.
it("Enter en el documento pasa a lo siguiente: no firma ni marca la firma que falta", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LinkConsentStep slug="dental-smile" token="t" consentId="c1" onSigned={() => {}} />
    </QueryClientProvider>,
  )
  const doc = await screen.findByLabelText("Escribe tu DNI")
  fireEvent.change(doc, { target: { value: "45678901" } })
  doc.focus()
  // Sin `preventDefault`, el navegador enviaría el formulario con Enter (envío implícito).
  expect(fireEvent.keyDown(doc, { key: "Enter" })).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.queryByText("Firma con el dedo en el recuadro.")).toBeNull()
  expect(sign).not.toHaveBeenCalled()
  expect(document.activeElement).not.toBe(doc)
})
