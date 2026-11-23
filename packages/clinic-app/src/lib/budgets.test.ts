import { describe, expect, it } from "vitest"
import { type BudgetLine, type BudgetOption, budgetPaths, budgetRowAmount, commonPlanItemIds, pendingTreatmentCounts, planKeysAfterDictation, revisionDroppedOptions, revisionScope } from "./budgets"

function option(id: string, position: number, extra: Partial<BudgetOption> = {}): BudgetOption {
  return {
    id,
    position,
    label: `Opción ${String.fromCharCode(64 + position)}`,
    isRecommended: false,
    decision: "pendiente",
    lineCount: 0,
    totalCents: null,
    acceptedCents: null,
    tariffTotalCents: null,
    discountCents: null,
    ...extra,
  }
}

function line(optionId: string, planItemId: string, priceCents: number, extra: Partial<BudgetLine> = {}): BudgetLine {
  return {
    id: `${optionId}-${planItemId}`,
    planId: "plan",
    budgetId: "budget",
    optionId,
    planItemId,
    serviceId: null,
    title: planItemId,
    scope: "tooth",
    toothNumber: 46,
    surfaces: [],
    quadrant: null,
    arch: null,
    priceCents,
    tariffPriceCents: priceCents,
    priceReason: null,
    promotionId: null,
    promotionName: null,
    promotionMode: null,
    billingMode: "treatment",
    sessionsPlanned: null,
    lineTotalCents: priceCents,
    tariffLineTotalCents: priceCents,
    lineDiscountCents: null,
    currency: "PEN",
    decision: "pendiente",
    itemStatus: "planificado",
    ...extra,
  }
}

// Ana: la resina 36 y la profilaxis van en los dos caminos; la 46 se conserva o se extrae.
const ana = {
  options: [option("extraer", 2), option("conservar", 1, { isRecommended: true })],
  items: [
    line("conservar", "resina", 150_00, { toothNumber: 36 }),
    line("conservar", "profilaxis", 80_00, { scope: "general", toothNumber: null }),
    line("conservar", "endodoncia", 600_00),
    line("conservar", "corona", 900_00),
    line("extraer", "resina", 150_00, { toothNumber: 36 }),
    line("extraer", "profilaxis", 80_00, { scope: "general", toothNumber: null }),
    line("extraer", "exodoncia", 200_00),
    line("extraer", "implante", 2500_00),
  ],
}

describe("commonPlanItemIds", () => {
  it("es común lo que está en todas las opciones con las mismas condiciones", () => {
    expect([...commonPlanItemIds(ana.items, 2)].sort()).toEqual(["profilaxis", "resina"])
  })

  it("con otro precio, otro cobro, otras sesiones u otra promoción en un camino ya no es común", () => {
    const changes: Array<Partial<BudgetLine>> = [
      { priceCents: 120_00 },
      { billingMode: "session" },
      { sessionsPlanned: 3 },
      { promotionId: "promo" },
    ]
    for (const change of changes) {
      const items = ana.items.map((entry) =>
        entry.optionId === "extraer" && entry.planItemId === "resina" ? { ...entry, ...change } : entry,
      )
      expect(commonPlanItemIds(items, 2).has("resina")).toBe(false)
    }
  })

  it("con tres caminos, lo que está solo en dos no es común", () => {
    const items = [line("a", "x", 100), line("b", "x", 100), line("a", "y", 50), line("b", "y", 50), line("c", "y", 50)]
    expect([...commonPlanItemIds(items, 3)]).toEqual(["y"])
  })
})

describe("budgetPaths", () => {
  it("lo común va una vez y cada camino, en su orden, con lo suyo", () => {
    const view = budgetPaths(ana)
    expect(view.common.map((entry) => entry.planItemId)).toEqual(["resina", "profilaxis"])
    // Una vez cada tratamiento, con la línea de la opción que vale (la recomendada).
    expect(view.common.every((entry) => entry.optionId === "conservar")).toBe(true)
    expect(view.paths.map((path) => path.option.id)).toEqual(["conservar", "extraer"])
    expect(view.paths.map((path) => path.own.map((entry) => entry.planItemId))).toEqual([
      ["endodoncia", "corona"],
      ["exodoncia", "implante"],
    ])
    expect(view.exclusive.map((entry) => entry.planItemId)).toEqual(["endodoncia", "corona", "exodoncia", "implante"])
  })

  it("un tratamiento con otro precio en cada camino es de los caminos, y cuenta una vez", () => {
    const items = ana.items.map((entry) =>
      entry.optionId === "extraer" && entry.planItemId === "profilaxis" ? { ...entry, priceCents: 60_00 } : entry,
    )
    const view = budgetPaths({ ...ana, items })
    expect(view.common.map((entry) => entry.planItemId)).toEqual(["resina"])
    expect(view.paths[1]?.own.map((entry) => entry.planItemId)).toEqual(["profilaxis", "exodoncia", "implante"])
    expect(view.exclusive.filter((entry) => entry.planItemId === "profilaxis")).toHaveLength(1)
  })
})

describe("revisionScope", () => {
  const ids = (lines: readonly BudgetLine[]) => lines.map((entry) => entry.planItemId)
  const shape = (scope: ReturnType<typeof revisionScope>) =>
    scope.groups.map((group) => [group.options.map((entry) => entry.id), ids(group.lines)])

  it("sin camino elegido lleva todos los caminos: lo común una vez y lo de cada camino", () => {
    const scope = revisionScope(ana)
    expect(ids(scope.lines)).toEqual(["resina", "profilaxis", "endodoncia", "corona", "exodoncia", "implante"])
    expect(shape(scope)).toEqual([
      [["conservar", "extraer"], ["resina", "profilaxis"]],
      [["conservar"], ["endodoncia", "corona"]],
      [["extraer"], ["exodoncia", "implante"]],
    ])
  })

  it("con un camino elegido lleva solo ese", () => {
    const options = ana.options.map((entry) =>
      entry.id === "extraer" ? { ...entry, decision: "elegida" } : { ...entry, decision: "no_elegida" },
    )
    const scope = revisionScope({ ...ana, options })
    expect(ids(scope.lines)).toEqual(["resina", "profilaxis", "exodoncia", "implante"])
    expect(scope.groups).toEqual([{ options: [], lines: scope.lines }])
  })

  it("un tratamiento con otro precio en cada camino se manda una vez, bajo los dos caminos", () => {
    const items = ana.items.map((entry) =>
      entry.optionId === "extraer" && entry.planItemId === "profilaxis" ? { ...entry, priceCents: 60_00 } : entry,
    )
    const scope = revisionScope({ ...ana, items })
    expect(new Set(ids(scope.lines)).size).toBe(scope.lines.length)
    // No es común para el servidor, pero va en los dos: desmarcarlo lo saca de los dos.
    expect(shape(scope)[0]).toEqual([["conservar", "extraer"], ["resina", "profilaxis"]])
    // La línea que se muestra es la de la opción que vale.
    expect(scope.lines.find((entry) => entry.planItemId === "profilaxis")?.priceCents).toBe(80_00)
  })

  it("con tres caminos, lo que va en dos tiene su grupo y ningún grupo queda vacío", () => {
    const three = {
      options: [option("a", 1, { isRecommended: true }), option("b", 2), option("c", 3)],
      items: [line("a", "x", 100), line("b", "x", 100), line("c", "x", 100), line("a", "y", 50), line("b", "y", 50), line("c", "z", 70)],
    }
    expect(shape(revisionScope(three))).toEqual([
      [["a", "b", "c"], ["x"]],
      [["c"], ["z"]],
      [["a", "b"], ["y"]],
    ])
  })

  it("con una sola opción lleva sus líneas", () => {
    const only = { options: [option("unica", 1, { isRecommended: true })], items: [line("unica", "resina", 150_00)] }
    expect(ids(revisionScope(only).lines)).toEqual(["resina"])
  })
})

describe("revisionDroppedOptions", () => {
  const all = ["resina", "profilaxis", "endodoncia", "corona", "exodoncia", "implante"]
  const without = (...ids: string[]) => new Set(all.filter((id) => !ids.includes(id)))

  it("con todo marcado no sale ninguna; sin lo propio de un camino, sale ese", () => {
    expect([...revisionDroppedOptions(ana, new Set(all))]).toEqual([])
    expect([...revisionDroppedOptions(ana, without("exodoncia"))]).toEqual([])
    expect([...revisionDroppedOptions(ana, without("exodoncia", "implante"))]).toEqual(["extraer"])
    // Desmarcar lo común no quita ningún camino.
    expect([...revisionDroppedOptions(ana, without("resina", "profilaxis"))]).toEqual([])
  })

  it("el camino que solo lleva lo común sigue mientras vaya algo suyo", () => {
    const subset = {
      options: [option("base", 1, { isRecommended: true }), option("mas", 2)],
      items: [line("base", "resina", 100), line("mas", "resina", 100), line("mas", "exodoncia", 50)],
    }
    expect([...revisionDroppedOptions(subset, new Set(["resina", "exodoncia"]))]).toEqual([])
    expect([...revisionDroppedOptions(subset, new Set(["resina"]))]).toEqual(["mas"])
  })

  it("si salieran todas no avisa (el servidor deja la primera); con un camino elegido no aplica", () => {
    expect([...revisionDroppedOptions(ana, new Set(["resina"]))]).toEqual([])
    const options = ana.options.map((entry) => (entry.id === "extraer" ? { ...entry, decision: "elegida" } : entry))
    expect([...revisionDroppedOptions({ ...ana, options }, new Set(["resina"]))]).toEqual([])
  })
})

// Verificación del 18 nov (10): Documentos decía «S/ 1,550.00» junto a «Eligió la opción A», y
// había aceptado S/ 650.
it("la fila de un presupuesto respondido dice lo que aceptó; sin responder, el total de la opción", () => {
  const choice = (decision: string, totalCents: number, acceptedCents: number) => ({
    id: decision,
    decision,
    isRecommended: false,
    lineCount: 2,
    totalCents,
    acceptedCents,
    tariffTotalCents: totalCents,
    discountCents: 0,
  })
  const budget = {
    status: "parcial",
    currency: "PEN",
    options: [choice("elegida", 155000, 65000), choice("no_elegida", 90000, 0)],
    totalCents: 155000,
    acceptedCents: 65000,
    tariffTotalCents: 155000,
    discountCents: 0,
  } as unknown as Parameters<typeof budgetRowAmount>[0]
  expect(budgetRowAmount(budget)).toEqual({ accepted: true, totals: [{ currency: "PEN", totalCents: 65000 }] })
  expect(budgetRowAmount({ ...budget, status: "presentado" }).totals).toMatchObject([
    { currency: "PEN", totalCents: 155000 },
  ])
})

// QA del 22 nov (H12): con dos caminos que se excluyen, la firma decía «2 por ejecutar»; solo uno se hará.
describe("pendingTreatmentCounts", () => {
  const path = (chosen: boolean) => ({ budgetId: "b-1", positions: [1], name: null, pathCount: 2, chosen })
  const item = (id: string, over: Record<string, unknown> = {}) => ({ id, status: "pendiente", decisionStatus: "pendiente", path: null, ...over })
  it("los caminos por elegir de un presupuesto cuentan como una elección, no como dos por ejecutar", () => {
    const items = [item("a", { path: path(false) }), item("b", { path: { ...path(false), positions: [2] } }), item("c")]
    expect(pendingTreatmentCounts(3, items)).toEqual({ toExecute: 1, choices: [2] })
  })
  it("elegido el camino, lo que queda se ejecuta", () => {
    expect(pendingTreatmentCounts(1, [item("a", { path: path(true) })])).toEqual({ toExecute: 1, choices: [] })
  })
  it("lo mismo en lo planificado y lo indicado cuenta una vez", () => {
    const shared = item("a", { path: path(false) })
    expect(pendingTreatmentCounts(2, [shared, shared, item("b", { path: { ...path(false), positions: [2] } })])).toEqual({ toExecute: 0, choices: [2] })
  })
})

// QA del 22 nov (H8, H9 del auditor): confirmados los dos caminos, el bloque Plan seguía diciendo «Todavía no
// hay tratamientos por hacer» hasta recargar: el plan nuevo no se volvía a leer.
describe("planKeysAfterDictation", () => {
  it("lo dictado que toca el plan vuelve a leer los planes, el presupuesto y lo que sigue", () => {
    for (const kind of ["plan", "procedimiento", "cita", "presupuesto"]) {
      expect(planKeysAfterDictation(kind)).toEqual(expect.arrayContaining(["treatment-plans", "plan-items", "budgets", "plan-next"]))
    }
    expect(planKeysAfterDictation("nota")).toEqual(["plan-items"])
  })
})
