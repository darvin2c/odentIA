// @vitest-environment jsdom

/**
 * La alergia que dijo la persona se corrige con «Agregar una corrección» y su motivo escrito
 * (auditor, 15 nov, A11 y D2): «era naproxeno y no ibuprofeno» no cabía en tres motivos fijos.
 * Los de siempre quedan como atajos que llenan el motivo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import type { Allergy } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

const remove = vi.hoisted(() => vi.fn())
vi.mock("../../lib/crm", () => ({ usePermission: () => true, useMemberName: () => () => "Dra. Ana Torres" }))
vi.mock("../../lib/patients", async (original) => ({
  ...(await original<typeof import("../../lib/patients")>()),
  removeAllergyApi: remove,
}))

const { RemoveAllergyDrawer, allergyRemovalWords } = await import("./allergies-card")

declareProduct(bareProduct("dental"))

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  // El cajón mira el ancho de la pantalla.
  window.matchMedia = ((query: string) => ({
    matches: true,
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
  remove.mockReset()
})

const ibuprofen = {
  id: "a1",
  substance: "Ibuprofeno",
  substanceSystem: null,
  substanceCode: null,
  source: "paciente",
  isActive: true,
  severity: "desconocida",
  createdAt: "2026-11-14T08:29:00.000Z",
} as unknown as Allergy

function show(allergy: Allergy) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RemoveAllergyDrawer patientId="p1" allergy={allergy} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe("corregir la alergia que dijo la persona", () => {
  it("la que dijo ella se corrige; la del equipo se quita", () => {
    expect(allergyRemovalWords(ibuprofen)).toMatchObject({ action: "Agregar una corrección", submit: "Guardar corrección" })
    expect(allergyRemovalWords({ ...ibuprofen, source: "equipo" })).toMatchObject({ action: "Quitar", submit: "Quitar alergia" })
  })

  it("se guarda con el motivo que se escribió", async () => {
    remove.mockResolvedValue({ data: { ...ibuprofen, isActive: false } })
    show(ibuprofen)
    const reason = screen.getByLabelText("Motivo")
    expect(reason.getAttribute("aria-required")).toBe("true")
    fireEvent.change(reason, { target: { value: " Era naproxeno y no ibuprofeno " } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar corrección" }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", "a1", "Era naproxeno y no ibuprofeno"))
  })

  it("un motivo de siempre se elige a un toque y llena el motivo", async () => {
    remove.mockResolvedValue({ data: { ...ibuprofen, isActive: false } })
    show(ibuprofen)
    fireEvent.click(screen.getByRole("button", { name: "Se registró por error" }))
    expect((screen.getByLabelText("Motivo") as HTMLTextAreaElement).value).toBe("Se registró por error")
    fireEvent.click(screen.getByRole("button", { name: "Guardar corrección" }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", "a1", "Se registró por error"))
  })

  it("sin motivo no se guarda y dice qué escribir", async () => {
    show(ibuprofen)
    fireEvent.click(screen.getByRole("button", { name: "Guardar corrección" }))
    expect(await screen.findByText(/Escribe por qué se quita/)).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
  })
})
