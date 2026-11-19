// @vitest-environment jsdom

/**
 * «Firmado en papel» con una hoja vieja (QA del 18 nov, H2): los riesgos propios cambiaron después
 * de imprimirla. Antes la foto se subía y después la firma se rechazaba: quedaba en Documentos una
 * «Hoja firmada» que no firmaba nada. Ahora se pregunta antes y la foto no se sube.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { ConsentDocument } from "../../lib/clinical-forms"
import { setOrgLocale } from "../../lib/locale"
import { bareProduct, declareProduct } from "../../product/product-ui"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
const upload = vi.hoisted(() => vi.fn(async () => ({ id: "doc-hoja" })))
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/encounter-documents", async (original) => ({
  ...(await original<typeof import("../../lib/encounter-documents")>()),
  uploadPatientFile: upload,
}))
vi.mock("../../lib/crm", () => ({ usePermission: () => true }))
vi.mock("../../lib/org", () => ({ useOrgProfile: () => ({ data: { countryCode: "PE" } }) }))

const { ApiError } = await import("../../lib/api")
const { PaperSignDrawer } = await import("./consent-signing")

declareProduct(bareProduct("dental"))

const document = {
  id: "consent-1",
  patientId: "p-carmen",
  titleSnapshot: "Exodoncia simple o quirúrgica",
  bodySnapshot: "",
  sectionsSnapshot: {
    purpose: "",
    procedure: "",
    benefits: [],
    risks: [],
    alternatives: [],
    consequences: "",
    personalRisks: ["Toma Eliquis: lo suspende 1 día."],
  },
  status: "pendiente",
  personSignedAt: null,
} as unknown as ConsentDocument

let paperCheck: (body: Record<string, unknown>) => Promise<unknown>

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView ??= () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

beforeEach(() => {
  upload.mockClear()
  paperCheck = async () => ({ data: { ok: true } })
  route.mockReset()
  route.mockImplementation(async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url === "/api/patients/p-carmen")
      return {
        data: {
          patient: {
            displayName: "Carmen Ruiz",
            docType: null,
            docNumber: null,
            patientNumber: 12,
          },
          contacts: [{ relationship: "self", contactId: "c-carmen", displayName: "Carmen Ruiz" }],
          isMinor: false,
        },
      }
    if (url === "/api/patients/p-carmen/responsibilities") return { data: [] }
    if (url === "/api/clinical-forms/professionals/me/profile")
      return {
        data: {
          userId: "u-demo",
          accountName: "Dr. Demo",
          signatureName: null,
          professionalTitle: "Cirujano dentista",
          registrationBody: "COP",
          registrationNumber: "12345",
          specialtyRegistration: null,
          complete: true,
          updatedAt: null,
        },
      }
    if (url === "/api/clinical-forms/consents/consent-1/paper-check") return paperCheck(body)
    if (url === "/api/clinical-forms/consents/consent-1/sign")
      return { data: { ...document, status: "firmado", pdfDocumentId: "pdf-1" } }
    if (url === "/api/clinical-forms/consents/consent-1/pdf") return { data: document }
    throw new Error(`sin ruta: ${url}`)
  })
})

afterEach(cleanup)

async function fillAndSave() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSigned = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <PaperSignDrawer
        open
        document={document}
        patientId="p-carmen"
        onClose={() => {}}
        onSigned={onSigned}
      />
    </QueryClientProvider>,
  )
  const file = new File(["hoja"], "hoja.jpg", { type: "image/jpeg" })
  fireEvent.change(await screen.findByLabelText("Foto de la hoja firmada"), {
    target: { files: [file] },
  })
  fireEvent.click(screen.getByRole("checkbox", { name: /Informé a Carmen/ }))
  fireEvent.click(screen.getByRole("button", { name: "Guardar firma en papel" }))
  return onSigned
}

it("si la hoja impresa ya no se firmaría, lo dice antes y no sube la foto", async () => {
  paperCheck = async () => {
    throw new ApiError(409, {
      code: "CONSENT_CHANGED",
      message:
        "Los riesgos propios cambiaron después de imprimir la hoja: imprímela de nuevo y que la firme.",
    })
  }
  await fillAndSave()
  expect(
    await screen.findByText(
      "Los riesgos propios cambiaron después de imprimir la hoja: imprímela de nuevo y que la firme.",
    ),
  ).toBeTruthy()
  expect(upload).not.toHaveBeenCalled()
  expect(route.mock.calls.some(([url]) => url.endsWith("/sign"))).toBe(false)
})

it("con la hoja al día, sube la foto y firma, con los riesgos de la hoja a la vista", async () => {
  const onSigned = await fillAndSave()
  await waitFor(() => expect(onSigned).toHaveBeenCalled())
  expect(upload).toHaveBeenCalledTimes(1)
  const order = route.mock.calls.map(([url]) => url)
  expect(order.indexOf("/api/clinical-forms/consents/consent-1/paper-check")).toBeLessThan(
    order.indexOf("/api/clinical-forms/consents/consent-1/sign"),
  )
  const sign = route.mock.calls.find(([url]) => url.endsWith("/sign"))
  expect(JSON.parse(String(sign?.[1]?.body)).personalRisksShown).toEqual([
    "Toma Eliquis: lo suspende 1 día.",
  ])
})
