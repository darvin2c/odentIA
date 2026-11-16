// @vitest-environment jsdom

/**
 * «Confirmar anulación» espera a saber qué cae (QA del 16 nov, Q2). Con la red lenta se podía
 * confirmar antes de que llegara la lista: salía sin casillas, se anulaba solo el hallazgo y su
 * diagnóstico quedaba «Definitivo» para firmarse.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { CorrectionPreview, CorrectionStart } from "../../lib/encounters"

const preview = vi.hoisted(() => vi.fn())
vi.mock("../../lib/encounters", async (original) => ({
  ...(await original<typeof import("../../lib/encounters")>()),
  fetchCorrectionPreview: preview,
}))

const { CorrectionChoices, useCorrection } = await import("./correction-choices")

afterEach(() => {
  cleanup()
  preview.mockReset()
})

const caries26: CorrectionPreview = {
  target: { kind: "finding", label: "Lesión de caries dental · 26" },
  findings: [],
  diagnoses: [{ ids: ["d-k021"], label: "K02.1 Caries de la dentina · 26", offered: true, note: null }],
  planItems: [{ ids: ["i-resina"], label: "Resina compuesta · Pieza 26", offered: true, note: null }],
  notices: [],
} as unknown as CorrectionPreview

/** El diálogo de anular, en lo que importa: las casillas y el botón, que envía lo marcado. */
function Dialog({ start, onSend }: { start: CorrectionStart | null; onSend: (marks: unknown) => void }) {
  const correction = useCorrection("p-1", "e-1", start)
  return (
    <>
      <CorrectionChoices
        preview={correction.preview}
        marks={correction.marks}
        onMarksChange={correction.setMarks}
        idPrefix="anular"
        loading={correction.loading}
        failed={correction.failed}
        error={correction.error}
        onRetry={correction.retry}
      />
      <button type="button" disabled={!correction.ready} onClick={() => onSend(correction.marks)}>
        Confirmar anulación
      </button>
    </>
  )
}

function mount(start: CorrectionStart | null, onSend: (marks: unknown) => void = () => {}) {
  const client = new QueryClient()
  const view = (next: CorrectionStart | null) => (
    <QueryClientProvider client={client}>
      <Dialog start={next} onSend={onSend} />
    </QueryClientProvider>
  )
  const page = render(view(start))
  return { open: (next: CorrectionStart | null) => page.rerender(view(next)) }
}

const confirm = () => screen.getByRole("button", { name: "Confirmar anulación" }) as HTMLButtonElement

it("mientras llega la lista de lo que cae no se puede confirmar, y al llegar viene todo marcado", async () => {
  let arrive: (value: { data: CorrectionPreview }) => void = () => {}
  preview.mockReturnValue(new Promise((resolve) => (arrive = resolve)))
  const sent = vi.fn()
  mount({ findingIds: ["f-26"] }, sent)
  // La red tarda: el botón espera y la pantalla lo dice.
  expect(confirm().disabled).toBe(true)
  expect(screen.getByText("Buscando qué más cae con esta anulación…")).toBeTruthy()
  fireEvent.click(confirm())
  expect(sent).not.toHaveBeenCalled()
  arrive({ data: caries26 })
  await waitFor(() => expect(confirm().disabled).toBe(false))
  expect(screen.getByRole("checkbox", { name: /También anular su diagnóstico de esta atención: K02\.1/ })).toBeTruthy()
  fireEvent.click(confirm())
  // Sale con su diagnóstico y lo indicado hoy desde él, no con las listas vacías.
  expect(sent).toHaveBeenCalledWith({ findingIds: [], diagnosisIds: ["d-k021"], planItemIds: ["i-resina"] })
})

it("si la vista previa falla no se anula a medias: lo dice y se puede reintentar", async () => {
  preview.mockRejectedValueOnce(new Error("sin red"))
  mount({ findingIds: ["f-26"] })
  await waitFor(() => expect(screen.getByText("No se pudo saber qué más cae con esta anulación")).toBeTruthy())
  expect(screen.getByText("No se anuló nada.")).toBeTruthy()
  expect(confirm().disabled).toBe(true)
  preview.mockResolvedValueOnce({ data: caries26 })
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
  await waitFor(() => expect(confirm().disabled).toBe(false))
})

it("al reabrir no pinta la lista de la vez anterior mientras llega la nueva", async () => {
  preview.mockResolvedValueOnce({ data: caries26 })
  const dialog = mount({ findingIds: ["f-26"] })
  await waitFor(() => expect(confirm().disabled).toBe(false))
  dialog.open(null)
  // En otra pestaña quitaron la resina: la lista nueva tarda en llegar.
  preview.mockReturnValue(new Promise(() => {}))
  dialog.open({ findingIds: ["f-26"] })
  await waitFor(() => expect(screen.getByText("Buscando qué más cae con esta anulación…")).toBeTruthy())
  expect(screen.queryByRole("checkbox", { name: /Y el tratamiento indicado hoy/ })).toBeNull()
  expect(confirm().disabled).toBe(true)
})
