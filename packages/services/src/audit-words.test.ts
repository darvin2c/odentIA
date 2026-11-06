import { expect, it } from "vitest"
import { alsoAuditWords, leadAuditIndex } from "./audit-words.js"

it("una acción con varios registros la nombra lo que se hizo, siempre el mismo, y lo demás va sin repetir y en orden", () => {
  // Un cobro: el ticket nombra la fila, venga en el orden que venga.
  const cobro = ["payment.applied", "cash.payment_registered", "payment.created", "ticket.created", "payment.applied"]
  expect(cobro[leadAuditIndex(cobro)]).toBe("ticket.created")
  const reversed = [...cobro].reverse()
  expect(reversed[leadAuditIndex(reversed)]).toBe("ticket.created")
  expect(alsoAuditWords(cobro, leadAuditIndex(cobro))).toEqual([
    { what: "Aplicó un pago a un cargo", count: 2 },
    { what: "Registró un cobro en caja", count: 1 },
    { what: "Registró un pago", count: 1 },
  ])
  // Sin una que la nombre: la misma en cualquier orden, y nunca lo que solo acompaña.
  const budget = ["budget.items_added", "budget.created"]
  const other = [...budget].reverse()
  expect(budget[leadAuditIndex(budget)]).toBe(other[leadAuditIndex(other)])
  expect(["cash.payment_registered", "budget.created"][leadAuditIndex(["cash.payment_registered", "budget.created"])]).toBe("budget.created")
  expect(leadAuditIndex(["payment.applied"])).toBe(0)
})
