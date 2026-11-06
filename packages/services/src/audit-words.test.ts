import { expect, it } from "vitest"
import { alsoAuditWords, leadAuditCount, leadAuditIndex } from "./audit-words.js"

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

it("firmar o anular una atención nombra la fila, con su cargo en «También»; lo repetido se cuenta", () => {
  // `finalizeEncounter` deja el cargo y la firma en la misma transacción.
  const firma = ["charge.created", "encounter.finalized", "plan.item_status_changed"]
  const lead = leadAuditIndex(firma)
  expect(firma[lead]).toBe("encounter.finalized")
  expect(alsoAuditWords(firma, lead).map((item) => item.what)).toContain("Registró un cargo")
  const anula = ["charge.voided", "encounter.voided"]
  expect(anula[leadAuditIndex(anula)]).toBe("encounter.voided")
  // Dos pagos sin ticket: «Registró un pago», 2 veces, y nada repetido en «También».
  const pagos = ["payment.created", "payment.applied", "payment.created"]
  expect(leadAuditCount(pagos, leadAuditIndex(pagos))).toBe(2)
  expect(alsoAuditWords(pagos, leadAuditIndex(pagos))).toEqual([{ what: "Aplicó un pago a un cargo", count: 1 }])
})
