// @vitest-environment jsdom

/**
 * «Documentos › Nuevo › Consentimiento» y el tratamiento del plan (mesa del 17 nov, hallazgo 1 del
 * novato): el consentimiento de la endodoncia firmado desde Documentos quedaba suelto y el Plan
 * seguía pidiéndolo. Con la plantilla elegida, el formulario trae el tratamiento que la pide ya
 * puesto (y lo que se consiente); si la piden varios, se elige uno, sin adivinar.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConsentTreatmentChoice } from "../../lib/clinical-forms"
import { setOrgLocale } from "../../lib/locale"
import { bareProduct, declareProduct } from "../../product/product-ui"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/crm", () => ({ usePermission: () => true }))

const { NewConsentDrawer } = await import("./consentimientos-tab")

declareProduct(bareProduct("dental"))

const endodoncia46: ConsentTreatmentChoice = {
  planItemId: "item-46",
  label: "Endodoncia posterior vital · pieza 46",
  procedureRef: "Endodoncia posterior vital · pieza 46 (primer molar inferior derecho)",
  diagnosisCode: null,
  diagnosisSystem: null,
}
const endodoncia36: ConsentTreatmentChoice = {
  ...endodoncia46,
  planItemId: "item-36",
  label: "Endodoncia posterior vital · pieza 36",
  procedureRef: "Endodoncia posterior vital · pieza 36 (primer molar inferior izquierdo)",
}

let treatments: ConsentTreatmentChoice[] = []
let created: Record<string, unknown> | null = null

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

beforeEach(() => {
  created = null
  route.mockReset()
  route.mockImplementation(async (url, init) => {
    if (url === "/api/clinical-forms/consent-templates?status=publicado")
      return { data: [{ id: "tpl-endo", title: "Tratamiento de conductos (endodoncia)" }] }
    if (url === "/api/clinical-forms/consents/treatments?patientId=p-1&templateId=tpl-endo")
      return { data: treatments }
    if (url === "/api/clinical-forms/consents" && init?.method === "POST") {
      created = JSON.parse(String(init.body)) as Record<string, unknown>
      return { data: { id: "consent-1" } }
    }
    throw new Error(`sin ruta: ${url}`)
  })
})

afterEach(cleanup)

function open(
  fromEncounter?: { procedureRef: string; todayPlanItemIds: string[] },
) {
  const onCreated = vi.fn(async () => {})
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <NewConsentDrawer
        open
        patientId="p-1"
        {...(fromEncounter
          ? {
              encounterId: "enc-1",
              defaultProcedureRef: fromEncounter.procedureRef,
              todayPlanItemIds: fromEncounter.todayPlanItemIds,
            }
          : {})}
        onClose={() => {}}
        onCreated={onCreated}
      />
    </QueryClientProvider>,
  )
  return onCreated
}

async function pick(combo: HTMLElement, option: string) {
  fireEvent.click(combo)
  const item = await screen.findByRole("option", { name: option })
  fireEvent.pointerDown(item, { pointerType: "mouse" })
  fireEvent.click(item)
  await waitFor(() => expect(combo.textContent).toContain(option))
}

const procedure = () =>
  screen.getByRole("textbox", { name: /Procedimiento al que aplica/ }) as HTMLInputElement

describe("el consentimiento nuevo y el tratamiento del plan que lo pide", () => {
  it("con uno solo, viene puesto con lo que se consiente y se genera unido a él", async () => {
    treatments = [endodoncia46]
    const onCreated = open()
    await pick(
      await screen.findByRole("combobox", { name: /^Plantilla/ }),
      "Tratamiento de conductos (endodoncia)",
    )
    const treatment = await screen.findByRole("combobox", { name: /^Tratamiento del plan/ })
    await waitFor(() =>
      expect(treatment.textContent).toContain("Endodoncia posterior vital · pieza 46"),
    )
    expect(procedure().value).toBe(endodoncia46.procedureRef)
    fireEvent.click(screen.getByRole("button", { name: "Generar consentimiento" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("consent-1"))
    expect(created).toMatchObject({
      templateId: "tpl-endo",
      patientId: "p-1",
      planItemId: "item-46",
      procedureRef: endodoncia46.procedureRef,
    })
    expect(created).not.toHaveProperty("outsidePlan")
  })

  it("con varios, no se adivina: pide elegir y se une al elegido", async () => {
    treatments = [endodoncia46, endodoncia36]
    const onCreated = open()
    await pick(
      await screen.findByRole("combobox", { name: /^Plantilla/ }),
      "Tratamiento de conductos (endodoncia)",
    )
    const treatment = await screen.findByRole("combobox", { name: /^Tratamiento del plan/ })
    expect(screen.getByText("Lo piden varios tratamientos: elige a cuál aplica.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Generar consentimiento" }))
    expect(await screen.findByText("Elige el tratamiento al que aplica")).toBeTruthy()
    expect(created).toBeNull()
    await pick(treatment, "Endodoncia posterior vital · pieza 36")
    expect(procedure().value).toBe(endodoncia36.procedureRef)
    fireEvent.click(screen.getByRole("button", { name: "Generar consentimiento" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(created).toMatchObject({ planItemId: "item-36" })
  })

  it("«Otro procedimiento, fuera del plan» no lo une y conserva lo escrito a mano", async () => {
    treatments = [endodoncia46]
    const onCreated = open()
    await pick(
      await screen.findByRole("combobox", { name: /^Plantilla/ }),
      "Tratamiento de conductos (endodoncia)",
    )
    const treatment = await screen.findByRole("combobox", { name: /^Tratamiento del plan/ })
    await waitFor(() => expect(treatment.textContent).toContain("pieza 46"))
    await pick(treatment, "Otro procedimiento, fuera del plan")
    expect(procedure().value).toBe("")
    fireEvent.change(procedure(), { target: { value: "Endodoncia de la 11" } })
    fireEvent.click(screen.getByRole("button", { name: "Generar consentimiento" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(created).toMatchObject({
      planItemId: null,
      outsidePlan: true,
      procedureRef: "Endodoncia de la 11",
    })
  })

  // Revisión del 17 nov: hoy se extrajo la 38 (tratamiento directo, ya realizado) y el plan tiene
  // otra exodoncia sin consentimiento. Venía unido a esa y borraba «Exodoncia simple · pieza 38».
  it("desde la atención, lo registrado hoy no se une solo a otro tratamiento ni se borra", async () => {
    treatments = [endodoncia46]
    const onCreated = open({ procedureRef: "Exodoncia simple · pieza 38", todayPlanItemIds: ["item-38"] })
    await pick(
      await screen.findByRole("combobox", { name: /^Plantilla/ }),
      "Tratamiento de conductos (endodoncia)",
    )
    const treatment = await screen.findByRole("combobox", { name: /^Tratamiento del plan/ })
    await waitFor(() =>
      expect(treatment.textContent).toContain("Otro procedimiento, fuera del plan"),
    )
    expect(procedure().value).toBe("Exodoncia simple · pieza 38")
    fireEvent.click(screen.getByRole("button", { name: "Generar consentimiento" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(created).toMatchObject({
      encounterId: "enc-1",
      planItemId: null,
      outsidePlan: true,
      procedureRef: "Exodoncia simple · pieza 38",
    })
  })

  it("desde la atención, si lo de hoy es uno de los que la piden, viene puesto ese", async () => {
    treatments = [endodoncia46, endodoncia36]
    open({ procedureRef: "Endodoncia posterior vital · pieza 36", todayPlanItemIds: ["item-36"] })
    await pick(
      await screen.findByRole("combobox", { name: /^Plantilla/ }),
      "Tratamiento de conductos (endodoncia)",
    )
    const treatment = await screen.findByRole("combobox", { name: /^Tratamiento del plan/ })
    await waitFor(() =>
      expect(treatment.textContent).toContain("Endodoncia posterior vital · pieza 36"),
    )
  })
})
