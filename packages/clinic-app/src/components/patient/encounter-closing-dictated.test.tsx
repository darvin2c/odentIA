// @vitest-environment jsdom

/**
 * «¿Cuándo vuelve?» con la cita que dictó (QA del 21 nov 2026, C8): Clío propuso «Cita · sáb 28 nov ·
 * otra resina», marcada para entrar con la firma, y el cierre decía «No indicaste cuándo vuelve».
 */
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ClosingControls } from "../../lib/encounters"
import { ClosingNextVisit, type ClosingValues, closingControlsBody, useClosingForm } from "./encounter-closing"

afterEach(cleanup)

const controls: ClosingControls = {
  due: [],
  byAppointment: [],
  next: null,
  recallMonths: 6,
  shortcuts: { week: "2026-11-28", month: "2026-12-21", recall: "2027-05-21" },
}
const empty: ClosingValues = {
  endTime: "",
  consentSkipReason: "",
  registrationSkipReason: "",
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
  nextControl: "week",
  nextControlDate: "",
  fulfill: {},
  finishChanges: {},
  consultation: "",
}
const visit = { id: "cita-1", day: "2026-11-28", appointment: true, what: "la otra resina" }

function Next() {
  const form = useClosingForm({ needsReason: () => false, needsRegistration: false, onSubmit: async () => {} })
  return <ClosingNextVisit form={form} controls={controls} dictated={visit} busy={false} />
}

describe("la cita dictada dice cuándo vuelve", () => {
  it("la nombra y no pide otro control", () => {
    render(<Next />)
    expect(screen.getByText(/Vuelve el .*28.* para la otra resina, con la cita que dictaste\./)).toBeTruthy()
    expect(screen.queryByText(/No indicaste cuándo vuelve/)).toBeNull()
    expect(closingControlsBody(empty, controls, visit)).toEqual({ followUpIds: [] })
  })
})
