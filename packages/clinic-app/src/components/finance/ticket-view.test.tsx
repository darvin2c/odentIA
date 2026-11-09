import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { CollectTicketRow } from "../../lib/finance-collect"
import { TicketView } from "./ticket-view"

vi.mock("../../lib/crm", () => ({ usePermission: () => true }))
vi.mock("../../lib/active-branch", () => ({
  useActiveBranch: () => ({ branches: [], branchId: undefined, effectiveId: undefined, choose: () => undefined }),
}))
vi.mock("../../lib/org", () => ({ useOrgSecondCurrency: () => null }))

function ticket(snapshot: Partial<CollectTicketRow["snapshot"]>, patientId: string | null = null): CollectTicketRow {
  return {
    id: "t1",
    patientId,
    buyerContactId: null,
    branchId: "b1",
    ticketNumber: 42,
    currency: "PEN",
    totalCents: 12000,
    creditAppliedCents: 0,
    cashReceivedCents: 20000,
    changeCents: 8000,
    payerContactId: null,
    requestId: null,
    createdBy: null,
    createdAt: "2026-11-08T15:00:00.000Z",
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    snapshot: {
      patient: null,
      buyer: null,
      issuer: { userId: "u1", name: "Caja" },
      branch: { id: "b1", name: "Sede Centro" },
      lines: [{ chargeId: "c1", description: "Lentes de sol", amountCents: 12000, appliedCents: 12000, promotion: null }],
      methods: [{ paymentMethodId: "m1", name: "Efectivo", typeCode: "10", amountCents: 12000, reference: null }],
      notice: "",
      remainingCents: 0,
      ...snapshot,
    },
  }
}

function render(row: CollectTicketRow): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TicketView ticket={row} remainingCents={0} patientName="" branchName="Sede Centro" locale="es-PE" mode="review" inAccount onChanged={() => undefined} />
    </QueryClientProvider>,
  )
}

// Venta de mostrador (ADR 0172): el ticket no es de una ficha y lo dice.
describe("el ticket de una venta de mostrador", () => {
  it("sin nombre dice «Venta de mostrador», no «Paciente», y no se envía", () => {
    const page = render(ticket({}))
    expect(page).toContain("Venta de mostrador")
    expect(page).not.toContain("Paciente:")
    expect(page).not.toContain("Enviar al paciente")
    expect(page).toContain("Imprimir")
  })
  it("con alguien dice «Cliente: …»", () => {
    const page = render(ticket({ buyer: { contactId: null, displayName: "Ana Torres" } }))
    expect(page).toContain("Cliente: Ana Torres")
    expect(page).not.toContain("Paciente:")
  })
  it("el de una ficha sigue diciendo «Paciente: …»", () => {
    const page = render(ticket({ patient: { id: "p1", displayName: "Rosa Quispe" } }, "p1"))
    expect(page).toContain("Paciente: Rosa Quispe")
    expect(page).not.toContain("Venta de mostrador")
  })
})
