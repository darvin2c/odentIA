// @vitest-environment jsdom

import { DetailDrawer } from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { FormResponse } from "../../lib/clinical-forms"
import { bareProduct, declareProduct } from "../../product/product-ui"

declareProduct(bareProduct("dental"))

const update = vi.hoisted(() => vi.fn())
vi.mock("../../lib/crm", () => ({ useMemberName: () => () => "Dra. Ana", useOrgMembers: () => [] }))
vi.mock("../../lib/clinical-forms", async (original) => ({
  ...(await original<typeof import("../../lib/clinical-forms")>()),
  updateFormResponse: update,
}))

const { ResponseDetail } = await import("./formularios-tab")

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
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
  update.mockReset()
  document.body.innerHTML = ""
})

const response: FormResponse = {
  id: "r1",
  organizationId: "o1",
  templateId: "t1",
  templateVersion: 1,
  templateSnapshot: {
    sections: [
      {
        id: "s1",
        title: "Dolor",
        fields: [
          { id: "intensidad", label: "Intensidad del dolor (0–10)", type: "numero", min: 0, max: 10 },
          { id: "hallazgos", label: "Hallazgos", type: "texto_largo" },
        ],
      },
    ],
  },
  patientId: "p1",
  encounterId: null,
  professionalUserId: null,
  status: "borrador",
  answers: { intensidad: 8, hallazgos: null },
  finalizedAt: null,
  templateTitle: "Evaluación de endodoncia",
  source: "staff",
  submittedAt: null,
  discardedAt: null,
  discardReason: null,
  createdAt: "2026-11-14T10:00:00Z",
  updatedAt: "2026-11-14T10:00:00Z",
}

/** El servidor guarda lo que vale; un número fuera de rango conserva lo guardado y se marca. */
function serverSaves() {
  update.mockImplementation(async (_id: string, body: { answers: Record<string, unknown> }) => {
    const answers = { ...body.answers }
    const rejected: Record<string, string> = {}
    if (typeof answers.intensidad === "number" && answers.intensidad > 10) {
      rejected["answers.intensidad"] = `Va de 0 a 10. El ${answers.intensidad} no se guardó; sigue «8».`
      answers.intensidad = 8
    }
    return { data: { ...response, answers, rejected } }
  })
}

function Panel() {
  const [open, setOpen] = useState(true)
  return (
    <QueryClientProvider client={new QueryClient()}>
      <DetailDrawer open={open} title="Evaluación de endodoncia" onClose={() => setOpen(false)}>
        {open ? <ResponseDetail response={response} canWrite onChanged={async () => {}} /> : null}
      </DetailDrawer>
      {open ? null : <p>Cerrado</p>}
    </QueryClientProvider>
  )
}

const close = () => fireEvent.click(screen.getByRole("button", { name: "Cerrar", hidden: true }))

// QA de la entrega 3 (14 nov): con un cambio que aún se estaba por guardar, «Salir sin guardar» decía
// que se perdería y, al elegir «Descartar y salir», el valor quedaba guardado igual.
describe("salir de un formulario que se guarda solo", () => {
  it("con un cambio que todavía no se guarda, salir no pregunta: lo guarda al cerrarse", async () => {
    serverSaves()
    render(<Panel />)
    fireEvent.change(await screen.findByLabelText(/Intensidad del dolor/), { target: { value: "7" } })
    close()
    await screen.findByText("Cerrado")
    expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1].answers.intensidad).toBe(7)
  })

  it("con un valor que no se guardó, pregunta y dice qué se pierde; «Descartar y salir» no guarda lo pendiente", async () => {
    serverSaves()
    render(<Panel />)
    fireEvent.change(await screen.findByLabelText(/Intensidad del dolor/), { target: { value: "15" } })
    await screen.findByText("Guardado, menos lo marcado", undefined, { timeout: 3000 })
    expect(update).toHaveBeenCalledTimes(1)

    // Otro cambio, aún sin guardar, con el 15 que no vale todavía ahí.
    fireEvent.change(screen.getByLabelText("Hallazgos"), { target: { value: "Percusión positiva" } })
    close()
    const dialog = await screen.findByRole("alertdialog", { hidden: true })
    expect(dialog.textContent).toContain("No se guardó «15» en «Intensidad del dolor (0–10)».")
    expect(dialog.textContent).toContain("Tampoco lo último que cambiaste")

    fireEvent.click(screen.getByRole("button", { name: "Descartar y salir", hidden: true }))
    await screen.findByText("Cerrado")
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(update).toHaveBeenCalledTimes(1)
  })

  it("con solo el valor que no vale, dice que lo demás ya está guardado", async () => {
    serverSaves()
    render(<Panel />)
    fireEvent.change(await screen.findByLabelText(/Intensidad del dolor/), { target: { value: "15" } })
    await screen.findByText("Guardado, menos lo marcado", undefined, { timeout: 3000 })
    close()
    const dialog = await screen.findByRole("alertdialog", { hidden: true })
    expect(dialog.textContent).toContain("No se guardó «15» en «Intensidad del dolor (0–10)». Lo demás ya está guardado.")
  })

  it("si se corrige el valor y se sale antes del guardado, no pregunta y se guarda lo corregido", async () => {
    serverSaves()
    render(<Panel />)
    const intensity = await screen.findByLabelText(/Intensidad del dolor/)
    fireEvent.change(intensity, { target: { value: "15" } })
    await screen.findByText("Guardado, menos lo marcado", undefined, { timeout: 3000 })
    fireEvent.change(intensity, { target: { value: "7" } })
    close()
    await screen.findByText("Cerrado")
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls[1]?.[1].answers.intensidad).toBe(7)
  })
})
