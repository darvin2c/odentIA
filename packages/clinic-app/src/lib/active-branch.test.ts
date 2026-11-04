import { describe, expect, it } from "vitest"
import { firstActiveBranchId } from "./active-branch"

// QA NT: sin sede guardada, la ficha y el inicio deben elegir la misma sede, aunque
// dos sedes se hayan creado en el mismo instante y la lista llegue en otro orden.
describe("firstActiveBranchId", () => {
  const same = "2026-10-01T10:00:00.000Z"

  it("con la misma fecha de creación elige la de menor id, sin depender del orden de la lista", () => {
    const rows = [
      { id: "b-sede", isActive: true, createdAt: same },
      { id: "a-sede", isActive: true, createdAt: same },
    ]
    expect(firstActiveBranchId(rows)).toBe("a-sede")
    expect(firstActiveBranchId([...rows].reverse())).toBe("a-sede")
  })

  it("elige la más antigua y se salta las inactivas", () => {
    const rows = [
      { id: "nueva", isActive: true, createdAt: "2026-11-01T10:00:00.000Z" },
      { id: "cerrada", isActive: false, createdAt: "2026-01-01T10:00:00.000Z" },
      { id: "antigua", isActive: true, createdAt: "2026-02-01T10:00:00.000Z" },
    ]
    expect(firstActiveBranchId(rows)).toBe("antigua")
  })

  it("sin sedes activas no elige ninguna", () => {
    expect(firstActiveBranchId([{ id: "x", isActive: false, createdAt: same }])).toBeUndefined()
    expect(firstActiveBranchId([])).toBeUndefined()
  })
})
