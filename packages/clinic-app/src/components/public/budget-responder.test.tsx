import { formatMoney, formatMoneyAmount } from "@odentia/clinical"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PortalBudget } from "../../lib/portal"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { BudgetResponder } from "./budget-responder"

declareProduct(bareProduct("dental"))

const plain: PortalBudget = {
  id: "b1",
  planId: "p1",
  budgetNumber: 12,
  revisionNumber: 1,
  title: "Plan",
  notes: null,
  status: "presentado",
  currency: "PEN",
  locale: "es-PE",
  totalCents: 65000,
  acceptedCents: null,
  tariffTotalCents: 65000,
  discountCents: 0,
  presentedAt: null,
  decidedAt: null,
  acceptedByName: null,
  decisionNote: null,
  stateText: "Entregado · espera respuesta",
  options: [
    { id: "o1", label: "Opción A", isRecommended: true, decision: "pendiente", totalCents: 65000 },
  ],
  items: [
    {
      planItemId: "i1",
      optionId: "o1",
      title: "Endodoncia del molar 46",
      scope: "tooth",
      toothNumber: 46,
      priceCents: 65000,
      tariffCents: 65000,
      billingMode: "treatment",
      sessionsPlanned: null,
      lineTotalCents: 65000,
      tariffLineTotalCents: 65000,
      promotionName: null,
      currency: "PEN",
      decision: "pendiente",
      itemStatus: "indicado",
    },
  ],
}

const html = (budget: PortalBudget) =>
  renderToStaticMarkup(
    <BudgetResponder budget={budget} pending={false} error={null} onAnswer={() => {}} />,
  )

describe("BudgetResponder", () => {
  it("sin explicación se ve como antes: nombre, precio y su respuesta, sin secciones vacías", () => {
    const page = html(plain)
    expect(page).toContain("Endodoncia del molar 46")
    expect(page).toContain("Acepto lo marcado")
    for (const absent of [
      "Vigente hasta",
      "Lo que encontramos",
      "Lo que te proponemos",
      "Cómo es este tratamiento",
      "Qué no incluye",
      "Calendario",
      "Señales de alarma",
      "Condiciones",
    ]) {
      expect(page).not.toContain(absent)
    }
  })

  it("con explicación dice todo lo que llega, y el desplegable no vive dentro de la etiqueta de la casilla", () => {
    const page = html({
      ...plain,
      validUntil: "2026-11-19",
      findings: "Una caries profunda llegó al nervio.",
      proposal: "Tratar el molar y sellarlo.",
      terms: { payment: "Cada tratamiento se paga al hacerse.", change: null },
      items: [
        {
          ...plain.items[0]!,
          patientGuide: {
            visits: "1 a 2",
            how: "Con anestesia.",
            excludes: "La corona.",
            schedule: [{ when: "Semana 1", what: "Control" }],
            warnings: "Fiebre.",
          },
        },
      ],
    })
    expect(page).toContain("Vigente hasta el 19 de noviembre de 2026")
    for (const present of [
      "Lo que encontramos",
      "Lo que te proponemos",
      "Cómo es este tratamiento",
      "Qué no incluye",
      "Calendario",
      "Señales de alarma",
      "Condiciones",
      "Cada tratamiento se paga al hacerse.",
    ]) {
      expect(page).toContain(present)
    }
    expect(page).not.toContain("Si el importe cambia")
    expect(page.match(/<label[^>]*>.*?<\/label>/s)?.[0]).not.toContain("<details")
  })

  it("con una moneda, la línea va sin símbolo y el total lo dice", () => {
    const page = html(plain)
    const soles = formatMoney(65000, "PEN", "es-PE")
    expect(page).toContain(`Aceptas ${soles} de ${soles}`)
    expect(page).toContain(`>${formatMoneyAmount(65000, "PEN", "es-PE")}</span>`)
    expect(page).not.toContain(" + ")
  })

  it("lo marcado sin precio dice que falta cotizarlo, no lo cuenta como cero", () => {
    const page = html({
      ...plain,
      items: [
        plain.items[0]!,
        {
          ...plain.items[0]!,
          planItemId: "i2",
          title: "Corona",
          lineTotalCents: null,
          priceCents: null,
        },
      ],
    })
    expect(page).toContain("Aceptas Por cotizar de")
  })

  it("con dos monedas, cada línea dice la suya y hay un total por cada una", () => {
    const totals = [
      { currency: "PEN", totalCents: 30000 },
      { currency: "USD", totalCents: 100000 },
    ]
    const page = html({
      ...plain,
      totals,
      totalCents: null,
      options: [{ ...plain.options[0]!, totals, totalCents: null }],
      items: [
        { ...plain.items[0]!, planItemId: "i1", lineTotalCents: 30000, currency: "PEN" },
        {
          ...plain.items[0]!,
          planItemId: "i2",
          title: "Implante",
          lineTotalCents: 100000,
          currency: "USD",
        },
      ],
    })
    const soles = formatMoney(30000, "PEN", "es-PE")
    const dollars = formatMoney(100000, "USD", "es-PE")
    expect(page).toContain(`>${soles}</span>`)
    expect(page).toContain(`>${dollars}</span>`)
    expect(page).toContain(`Aceptas ${soles} + ${dollars} de ${soles} + ${dollars}`)
    expect(page).not.toContain("Por cotizar")
  })
})
