// @vitest-environment jsdom

/**
 * El cierre no manda a «Realizado hoy», que ya no existe (mesa del 17 nov): lo que sigue en
 * curso se responde con «¿Terminaste?» en el mismo cierre, y lo que no se registró se registra
 * en su fila del plan.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ClosingSessions } from "./encounter-closing"

afterEach(cleanup)

const endo = { planItemId: "endo", title: "Endodoncia", n: 1, m: 2 }
const resin = { planItemId: "resina", title: "Resina", n: 0, m: 1 }

it("lo que sigue en curso pregunta «¿Terminaste?» con «Sigue en curso» elegido, y nada dice «Realizado hoy»", () => {
  const onAnswer = vi.fn()
  render(
    <ClosingSessions
      sessions={{ finishing: [], continuing: [endo], notRegistered: [resin] }}
      labelOf={(session) => session.title}
      answers={{}}
      onAnswer={onAnswer}
      disabled={false}
    />,
  )
  expect(screen.getByText(/¿Terminaste\?/)).toBeTruthy()
  expect(screen.getByRole("button", { name: "Sigue en curso", pressed: true })).toBeTruthy()
  expect(screen.getByText("Sigue en curso: le queda la sesión 2.")).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Realizado hoy|«Completar»/)
  expect(document.body.textContent).toMatch(/regístrala en el plan, en su fila/)
  fireEvent.click(screen.getByRole("button", { name: "Sí, terminar" }))
  expect(onAnswer).toHaveBeenCalledWith("endo", "terminar")
})

it("respondido «Sí, terminar», dice que queda realizado en la sesión 1 de 2", () => {
  render(
    <ClosingSessions
      sessions={{ finishing: [], continuing: [endo] }}
      labelOf={(session) => session.title}
      answers={{ endo: "terminar" }}
      onAnswer={() => undefined}
      disabled={false}
    />,
  )
  expect(screen.getByText("Al firmar queda realizado, en la sesión 1 de 2.")).toBeTruthy()
})
