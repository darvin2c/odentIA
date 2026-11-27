/**
 * Las franjas de entrega y a quién se le asigna (entrega 3, tablero 6), sin base: cómo se lee una
 * franja, qué se acepta al configurarlas y qué se elige al asignar un repartidor.
 */
import { describe, expect, it } from "vitest"
import { missedInput, rescheduleInput, shipInput } from "./pedidos.js"
import { courierChoice, sameSlot, slotLabel, slotsInput } from "./repartidores.js"

describe("las franjas", () => {
  it("se leen como en la tienda: «9–13 h», con los minutos solo si los hay", () => {
    expect(slotLabel({ start: 540, end: 780 })).toBe("9–13 h")
    expect(slotLabel({ start: 570, end: 780 })).toBe("9:30–13 h")
    expect(slotLabel({ start: 1080, end: 1260 })).toBe("18–21 h")
  })

  it("se guardan en orden; una que termina antes de empezar o repetida no vale", () => {
    const ok = slotsInput.parse({
      slots: [
        { start: 840, end: 1080 },
        { start: 540, end: 780 },
      ],
    })
    expect(ok.slots.map(slotLabel)).toEqual(["9–13 h", "14–18 h"])
    expect(slotsInput.safeParse({ slots: [{ start: 780, end: 540 }] }).success).toBe(false)
    expect(
      slotsInput.safeParse({
        slots: [
          { start: 540, end: 780 },
          { start: 540, end: 780 },
        ],
      }).success,
    ).toBe(false)
    // Sin franjas también vale: son opcionales.
    expect(slotsInput.parse({ slots: [] }).slots).toEqual([])
  })

  it("sin franja es una franja más al comparar", () => {
    expect(sameSlot(null, null)).toBe(true)
    expect(sameSlot(null, { start: 540, end: 780 })).toBe(false)
    expect(sameSlot({ start: 540, end: 780 }, { start: 540, end: 780 })).toBe(true)
  })
})

describe("mover una entrega", () => {
  it("«Pasar a…» y «No se entregó» llevan franja y repartidor solo si se eligen", () => {
    expect(rescheduleInput.parse({ deliverOn: "2026-11-26" })).toEqual({
      deliverOn: "2026-11-26",
    })
    expect(
      missedInput.parse({
        reason: "No contestó",
        deliverOn: "2026-11-26",
        slot: { start: 540, end: 780 },
        courier: { name: "  Kevin " },
      }),
    ).toMatchObject({ slot: { start: 540, end: 780 }, courier: { name: "Kevin" } })
    expect(rescheduleInput.parse({ deliverOn: "2026-11-26", slot: null, courier: null })).toEqual({
      deliverOn: "2026-11-26",
      slot: null,
      courier: null,
    })
  })

  it("el repartidor es uno que ya está, una persona del equipo o un nombre escrito", () => {
    expect(courierChoice.safeParse({ courierId: "no-es-un-id" }).success).toBe(false)
    expect(courierChoice.safeParse({ name: "   " }).success).toBe(false)
    expect(courierChoice.parse({ userId: "u-lucia" })).toEqual({ userId: "u-lucia" })
    // Una cosa a la vez: no se mezcla un id con un nombre.
    expect(
      courierChoice.safeParse({ courierId: "6f1c1c6e-5a55-4a43-9a43-0c0d7b1f7a10", name: "Kevin" })
        .success,
    ).toBe(false)
  })

  it("«Salió» por agencia: la agencia escrita, sin espacios de más; vacía, ninguna", () => {
    expect(shipInput.parse({ agency: "  Shalom   Arequipa ", tracking: " 77812 " })).toEqual({
      agency: "Shalom Arequipa",
      tracking: "77812",
    })
    expect(shipInput.parse({})).toEqual({ agency: null, tracking: null })
  })
})
