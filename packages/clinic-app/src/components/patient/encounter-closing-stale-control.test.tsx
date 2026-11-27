// @vitest-environment jsdom

/**
 * «Sí, terminar» en la sesión 1 de 2 de la endodoncia con el control dictado «para la segunda
 * sesión» (QA del 26 nov, H6): su fila en «Controles que quedan» lo sugiere quitar y se quita ahí;
 * si la endodoncia sigue, la fila es la de siempre. Nada se quita sin tocar «Quitar».
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ClosingControls } from "../../lib/encounters"
import {
  ClosingNextVisit,
  type ClosingValues,
  type ContinuingVisit,
  closingControlsBody,
  staleControlSaid,
  useClosingForm,
} from "./encounter-closing"

afterEach(cleanup)

const control = {
  id: "control-1",
  title: "Control en 1 semana",
  dueAt: "2026-12-03T14:00:00.000Z",
  status: "pendiente",
  scheduledAt: null,
  forSession: { planItemId: "endo", title: "Endodoncia", session: 2 },
}
const controls: ClosingControls = {
  due: [],
  byAppointment: [],
  next: { ...control, own: true },
  open: [control],
  recallMonths: 6,
  shortcuts: { week: "2026-12-03", month: "2026-12-26", recall: "2027-05-26" },
}
const empty: ClosingValues = {
  endTime: "",
  consentSkipReason: "",
  registrationSkipReason: "",
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
  nextControl: "",
  nextControlDate: "",
  fulfill: {},
  finishChanges: {},
  consultation: "",
}

let values: ClosingValues = empty
function Next({ continuing = [] }: { continuing?: ContinuingVisit[] }) {
  const form = useClosingForm({ needsReason: () => false, needsRegistration: false, onSubmit: async () => {} })
  values = form.state.values
  return (
    <>
      <ClosingNextVisit form={form} controls={controls} busy={false} continuing={continuing} />
      <button type="button" onClick={() => (values = form.state.values)}>
        leer
      </button>
    </>
  )
}

describe("el control de la segunda sesión de lo que termina con esta firma", () => {
  it("su fila lo sugiere quitar; «Quitar» lo manda al firmar y «Deshacer» lo deja", () => {
    render(<Next />)
    expect(
      screen.getByText("Sugerencia: la endodoncia termina con esta firma; este control era para su segunda sesión."),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }))
    fireEvent.click(screen.getByRole("button", { name: "leer" }))
    expect(closingControlsBody(values, controls, null)).toMatchObject({ dropFollowUpIds: ["control-1"] })
    // Quitado, ya no dice que vuelve con él: «¿Cuándo vuelve?» se pregunta.
    expect(screen.getByRole("button", { name: "En 1 semana" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }))
    fireEvent.click(screen.getByRole("button", { name: "leer" }))
    expect(closingControlsBody(values, controls, null)).not.toHaveProperty("dropFollowUpIds")
  })

  it("sin tocar «Quitar» no se quita nada", () => {
    render(<Next />)
    expect(closingControlsBody(values, controls, null)).not.toHaveProperty("dropFollowUpIds")
  })

  it("si la endodoncia sigue en curso, la fila es la de siempre, sin sugerencia ni «Quitar»", () => {
    render(<Next continuing={[{ planItemId: "endo", label: "Endodoncia · 46", n: 2, m: 2 }]} />)
    expect(screen.queryByText(/Sugerencia:/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull()
    expect(screen.getByText(/se cambia en Plan y controles/)).toBeTruthy()
  })

  it("el artículo y la sesión, dichos en la frase", () => {
    expect(staleControlSaid({ title: "Tratamiento de conducto", session: 3 })).toBe(
      "Sugerencia: el tratamiento de conducto termina con esta firma; este control era para su tercera sesión.",
    )
    expect(staleControlSaid({ title: "Prótesis", session: 12 })).toMatch(/^Sugerencia: la prótesis .* su sesión 12\.$/)
  })
})
