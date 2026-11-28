import { describe, expect, it } from "vitest"
import {
  byWhen,
  firstName,
  greeting,
  listText,
  longDay,
  type SetupFacts,
  sameText,
  setupProgress,
  stepView,
  type ToDoItem,
} from "./inicio"

const STORE = { name: "Calzados Rosa", timeZone: "America/Lima" }
const FACTS: SetupFacts = {
  country: "PE",
  productsWithStock: 18,
  payments: ["Yape", "Plin", "Efectivo al recibir"],
  deliveries: ["Reparto en Lima", "Recojo en tienda"],
  chats: null,
  triedSofi: false,
  members: 1,
  invitations: 0,
}

describe("el saludo y el día, con la hora de la tienda", () => {
  it("saluda según la hora de Lima, aunque el equipo esté en otra", () => {
    // 15:30 UTC son las 10:30 en Lima; 20:00 UTC, las 15:00; 03:00 UTC, las 22:00 del día antes.
    expect(greeting("America/Lima", new Date("2026-11-26T15:30:00Z"))).toBe("Buenos días")
    expect(greeting("America/Lima", new Date("2026-11-26T20:00:00Z"))).toBe("Buenas tardes")
    expect(greeting("America/Lima", new Date("2026-11-27T03:00:00Z"))).toBe("Buenas noches")
  })

  it("dice el día entero y el primer nombre", () => {
    expect(longDay("2026-11-25")).toBe("Miércoles 25 de noviembre")
    expect(longDay("2026-12-01")).toBe("Martes 1 de diciembre")
    expect(firstName("  Rosa Quispe ")).toBe("Rosa")
  })
})

describe("los primeros pasos", () => {
  it("cada paso dice cómo va con lo guardado y lleva a su apartado", () => {
    expect(stepView("datos", "hecho", FACTS, STORE)).toEqual({
      title: "Datos de la tienda",
      detail: "Calzados Rosa · Perú · hora de Lima",
      action: { label: "Revisar", path: "/configuracion/datos" },
    })
    expect(stepView("catalogo", "hecho", FACTS, STORE).detail).toBe("18 productos con su stock.")
    expect(stepView("pagos", "hecho", FACTS, STORE).detail).toBe("Yape, Plin y Efectivo al recibir")
    expect(stepView("equipo", "falta", FACTS, STORE).action).toEqual({
      label: "Invitar",
      path: "/configuracion/equipo",
    })
    expect(stepView("sofi", "falta", FACTS, STORE).action?.path).toBe("/configuracion/sofi")
  })

  it("los chats todavía no se pueden conectar: dicen «Muy pronto» y no llevan a ningún lado", () => {
    const chats = stepView("chats", "pronto", FACTS, STORE)
    expect(chats.action).toBeNull()
    expect(chats.detail).toContain("Muy pronto")
  })

  it("cuenta lo hecho y lo saltado, de los pasos que cuentan", () => {
    expect(
      setupProgress([
        { state: "hecho" },
        { state: "hecho" },
        { state: "falta" },
        { state: "saltado" },
        { state: "pronto" },
      ]),
    ).toEqual({ done: 3, total: 4 })
  })

  it("junta los nombres como se dicen", () => {
    expect(listText([])).toBe("")
    expect(listText(["Yape"])).toBe("Yape")
    expect(listText(["Yape", "Plin"])).toBe("Yape y Plin")
  })
})

describe("«Te toca»", () => {
  const pago: ToDoItem = {
    kind: "pago",
    when: "ahora",
    orderId: "o-1",
    number: "0154",
    customer: "Camila Ríos",
    amountCents: 14900,
    method: "Yape",
    byLink: false,
    at: "2026-11-26T15:00:00Z",
  }
  const misma: ToDoItem = {
    kind: "misma",
    when: "hoy",
    reason: "nombre",
    a: { id: "c-1", name: "Mariela Ríos" },
    b: { id: "c-2", name: "Mariela Ríos" },
    more: 0,
  }

  it("va en ahora, hoy y sin apuro, sin los tiempos vacíos", () => {
    expect(byWhen([misma, pago]).map((g) => g.when)).toEqual(["ahora", "hoy"])
    expect(byWhen([])).toEqual([])
  })

  it("pregunta si son la misma clienta con lo que las hace parecidas", () => {
    expect(sameText(misma as Extract<ToDoItem, { kind: "misma" }>)).toBe(
      "¿Las dos fichas de Mariela Ríos son la misma clienta?",
    )
    expect(
      sameText({
        ...(misma as Extract<ToDoItem, { kind: "misma" }>),
        reason: "telefono",
        b: { id: "c-3", name: "Mari R." },
        more: 2,
      }),
    ).toBe(
      "¿Mari R. es la misma clienta que Mariela Ríos? Tienen el mismo teléfono. Hay 2 parejas más por mirar.",
    )
  })
})
