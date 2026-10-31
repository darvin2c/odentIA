import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, it, vi } from "vitest"
import { useBudgetPapers } from "./budget-papers"
import { fetchBudgets } from "./budgets"

let allowed = true
vi.mock("./crm", () => ({
  usePermission: (permission: string) => permission === "budgets.read" && allowed,
}))
vi.mock("./budgets", () => ({ fetchBudgets: vi.fn(async () => ({ data: [] })) }))

function Rows() {
  const { budgets } = useBudgetPapers("p1")
  return <span>{budgets.length} filas</span>
}

const render = () => {
  // Lo que el Plan ya trajo: aun en la misma pestaña, sin permiso no se muestra.
  const client = new QueryClient()
  client.setQueryData(["budgets", "p1"], { data: [{ id: "b1" }] })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Rows />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  allowed = true
  vi.mocked(fetchBudgets).mockClear()
})

it("con `budgets.read`, los presupuestos son filas de Documentos", () => {
  expect(render()).toContain("1 filas")
})

it("sin `budgets.read` no hay filas ni se piden", () => {
  allowed = false
  expect(render()).toContain("0 filas")
  expect(fetchBudgets).not.toHaveBeenCalled()
})
