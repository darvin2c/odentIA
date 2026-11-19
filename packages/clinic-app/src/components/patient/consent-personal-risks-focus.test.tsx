// @vitest-environment jsdom

/**
 * Tras «Guardar» los riesgos propios, el foco vuelve al campo (verificación del 18 nov, H1): se
 * enfocaba mientras el campo seguía desactivado por el envío, y caía a `body`; el lector de
 * pantalla perdía el sitio.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { ConsentDocument } from "../../lib/clinical-forms"
import { resetRisksDraftsForTest } from "../../lib/consent-risks-draft"
import { setOrgLocale } from "../../lib/locale"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/crm", () => ({ usePermission: () => false }))

const { ConsentPersonalRisksField } = await import("./consent-personal-risks")

const document = {
  id: "consent-1",
  patientId: "p-1",
  planItemId: "item-48",
  status: "pendiente",
  personSignedAt: null,
  linkSentAt: null,
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
  sectionsSnapshot: {
    purpose: "",
    procedure: "",
    benefits: [],
    risks: [],
    alternatives: [],
    consequences: "",
    personalRisks: ["Toma apixabán: puede sangrar más."],
  },
} as unknown as ConsentDocument

let finishSave: (() => void) | null = null

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  Element.prototype.scrollIntoView ??= () => {}
})

beforeEach(() => {
  resetRisksDraftsForTest()
  finishSave = null
  route.mockReset()
  route.mockImplementation(async (url, init) => {
    if (url === "/api/clinical-forms/consents/consent-1/personal-risks/proposed")
      return { data: ["Toma apixabán: puede sangrar más."] }
    if (url === "/api/clinical-forms/consents/consent-1/personal-risks" && init?.method === "PUT") {
      // La respuesta tarda: mientras, el campo está desactivado.
      await new Promise<void>((resolve) => {
        finishSave = resolve
      })
      return { data: document }
    }
    throw new Error(`sin ruta: ${url}`)
  })
})

afterEach(cleanup)

it("después de «Guardar», el foco queda en el campo, no en body", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConsentPersonalRisksField document={document} onSaved={async () => {}} />
    </QueryClientProvider>,
  )
  const field = screen.getByRole("textbox", { name: /Riesgos propios/ }) as HTMLTextAreaElement
  fireEvent.change(field, { target: { value: "Toma apixabán: puede sangrar más.\nUsa prótesis." } })
  const save = screen.getByRole("button", { name: "Guardar" })
  save.focus()
  fireEvent.click(save)
  await waitFor(() => expect(field.disabled).toBe(true))
  await waitFor(() => expect(finishSave).not.toBeNull())
  finishSave?.()
  await waitFor(() => expect(field.disabled).toBe(false))
  await waitFor(() => expect(window.document.activeElement).toBe(field))
})
