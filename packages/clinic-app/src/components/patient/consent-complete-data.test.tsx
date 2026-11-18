// @vitest-environment jsdom

/**
 * Lo que falta para firmar se completa al lado (tablero 8 de la atención agrupada): «Completar»
 * abre los datos de quien corresponde a quien puede guardarlos, y a los demás les dice a quién
 * pedírselo, sin abrir nada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const route = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
const permissions = vi.hoisted(() => ({ write: true }))
vi.mock("../../lib/crm", () => ({
  usePermission: (key: string) => (key === "patients.write" ? permissions.write : true),
}))
vi.mock("../../lib/org", () => ({ useOrgProfile: () => ({ data: { countryCode: "PE" } }) }))
// Los cajones pesados se sustituyen por una marca: aquí importa cuál se abre y con qué.
vi.mock("./filiacion-section-drawer", () => ({
  FiliacionSectionDrawer: (props: {
    patient?: { id: string }
    person?: { id: string }
    missing?: Array<{ key: string }>
  }) => (
    <div role="dialog" aria-label="Datos">
      {props.patient ? `ficha ${props.patient.id}` : `persona ${props.person?.id}`}:{" "}
      {(props.missing ?? []).map((datum) => datum.key).join(",")}
    </div>
  ),
}))
vi.mock("./responsables-tab", () => ({
  ResponsablesTab: (props: { startGranting?: boolean }) => (
    <div>responsables{props.startGranting ? " con formulario" : ""}</div>
  ),
}))

const { CompleteSigningData } = await import("./consent-signing")

beforeAll(() => {
  // El cajón de responsables es el real: mide la ventana y anima su entrada.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
})

let minor = false
let representatives: unknown[] = []

beforeEach(() => {
  permissions.write = true
  minor = false
  representatives = []
  route.mockReset()
  route.mockImplementation(async (url) => {
    if (url === "/api/patients/p-1")
      return {
        data: {
          patient: { id: "p-1", givenNames: "Ana" },
          contacts: [{ contactId: "c-ana", displayName: "Ana Torres", relationship: "self" }],
          isMinor: minor,
        },
      }
    if (url === "/api/people/c-rosa") return { data: { id: "c-rosa", displayName: "Rosa Torres" } }
    if (url.includes("responsibilit")) return { data: representatives }
    throw new Error(`sin respuesta para ${url}`)
  })
})
afterEach(cleanup)

function show(gap: "sin-fecha" | "sin-documento" | "sin-representante") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CompleteSigningData patientId="p-1" gap={gap} />
    </QueryClientProvider>,
  )
}

describe("«Completar» lo que falta para firmar", () => {
  it("la fecha de nacimiento del paciente se completa al lado, solo ese dato", async () => {
    show("sin-fecha")
    fireEvent.click(await screen.findByRole("button", { name: "Completar" }))
    expect(await screen.findByRole("dialog", { name: "Datos" })).toHaveProperty(
      "textContent",
      "ficha p-1: birthDate",
    )
  })

  it("quien no puede guardar datos lee a quién pedírselo, sin botón", async () => {
    permissions.write = false
    show("sin-fecha")
    expect(await screen.findByText("Pídeselo a recepción.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Completar" })).toBeNull()
  })

  it("el documento que falta de un menor es el de su representante, no el del niño", async () => {
    minor = true
    representatives = [
      {
        isCurrent: true,
        kind: "representante_legal",
        contact: { id: "c-rosa", displayName: "Rosa Torres", docType: null, docNumber: null },
      },
    ]
    show("sin-documento")
    fireEvent.click(await screen.findByRole("button", { name: "Completar" }))
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Datos" }).textContent).toBe(
        "persona c-rosa: docType,docNumber",
      ),
    )
  })

  it("un menor sin representante: «Completar» abre sus responsables con el formulario listo", async () => {
    minor = true
    show("sin-representante")
    fireEvent.click(await screen.findByRole("button", { name: "Completar" }))
    expect(await screen.findByText("responsables con formulario")).toBeTruthy()
  })
})
