import { describe, expect, it } from "vitest"
import { routeToolsFor } from "./route.js"

/**
 * «¿Ya están mis lentes?» (ADR 0171): donde la clínica trabaja con pedidos, los
 * caminos donde se pregunta por ellos traen `ver_pedidos`; donde no, nada cambia.
 */
describe("los pedidos en el camino del turno", () => {
  it("donde el turno tiene ver_pedidos, información, citas y el caso derivado lo traen", () => {
    const available = new Set(["ver_pedidos", "ver_presupuesto", "create_task"])
    for (const path of ["informacion", "cita", "cambio_cita", "derivar"] as const)
      expect(routeToolsFor(path, available), path).toContain("ver_pedidos")
    expect(routeToolsFor("saludo", available)).not.toContain("ver_pedidos")
  })

  it("donde no lo tiene, los caminos son los de siempre", () => {
    const without = new Set(["ver_presupuesto"])
    for (const path of ["informacion", "cita", "cambio_cita", "derivar", "saludo"] as const)
      expect(routeToolsFor(path, without) ?? [], path).not.toContain("ver_pedidos")
  })
})
