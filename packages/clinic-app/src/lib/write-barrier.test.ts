import { describe, expect, it } from "vitest"
import { untilWritten } from "./write-barrier"

describe("la barrera de escritura del borrador", () => {
  it("drena hasta que no queda nada, también si llegó algo mientras guardaba", async () => {
    const dirty = new Set(["reason"])
    let rounds = 0
    await untilWritten({
      drain: async () => {
        rounds += 1
        // En la primera tanda se escribió la evolución: la segunda la guarda.
        dirty.clear()
        if (rounds === 1) dirty.add("evolution")
      },
      pending: () => [...dirty],
      inConflict: () => false,
      conflictError: () => new Error("no debería"),
    })
    expect(rounds).toBe(2)
  })

  // QA del 6 nov: otra pestaña cambió la evolución; quedaba sin enviar para
  // siempre y la barrera repetía el drenado sin fin, congelando la atención.
  it("si solo queda lo que otra pestaña cambió, corta con ese aviso en vez de girar sin fin", async () => {
    const dirty = new Set(["evolution", "reason"])
    const conflict = new Set(["evolution"])
    const stale = new Error("Otra pestaña cambió lo marcado")
    let rounds = 0
    await expect(
      untilWritten({
        drain: async () => {
          rounds += 1
          // Lo que no está en conflicto se guarda; lo en conflicto se queda.
          for (const key of [...dirty]) if (!conflict.has(key)) dirty.delete(key)
        },
        pending: () => [...dirty],
        inConflict: (key) => conflict.has(key),
        conflictError: () => stale,
      }),
    ).rejects.toBe(stale)
    expect(rounds).toBe(1)
  })
})
