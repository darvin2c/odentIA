/**
 * Los primeros pasos de una tienda nueva (tablero 16), sin base: cada paso se marca solo con lo
 * guardado, se salta solo lo que no aplica a toda tienda y la lista queda lista cuando no falta
 * ninguno. Leer lo guardado y anotar que quedó lista se prueba con la base en `app.test.ts`.
 */
import { describe, expect, it } from "vitest"
import {
  CHATS_READY,
  type SetupFacts,
  SKIPPABLE_STEPS,
  setupFinished,
  setupSteps,
} from "./primeros-pasos.js"

/** Una tienda recién creada: solo sus datos (el país lo elige al crearla). */
const NEW: SetupFacts = {
  country: "PE",
  productsWithStock: 0,
  payments: [],
  deliveries: [],
  chats: null,
  triedSofi: false,
  members: 1,
  invitations: 0,
}

const stateOf = (facts: SetupFacts, skipped: Parameters<typeof setupSteps>[1] = []) =>
  Object.fromEntries(setupSteps(facts, skipped).map((s) => [s.step, s.state]))

describe("cómo va cada paso", () => {
  it("una tienda recién creada: sus datos hechos, lo demás falta y los chats, muy pronto", () => {
    expect(stateOf(NEW)).toEqual({
      datos: "hecho",
      catalogo: "falta",
      pagos: "falta",
      entregas: "falta",
      chats: "pronto",
      sofi: "falta",
      equipo: "falta",
    })
    expect(setupFinished(setupSteps(NEW, []))).toBe(false)
  })

  it("cada paso se marca con lo que ya está guardado, nunca a mano", () => {
    const facts: SetupFacts = {
      ...NEW,
      country: null,
      productsWithStock: 18,
      payments: ["Yape", "Plin"],
      deliveries: ["Reparto en Lima"],
      triedSofi: true,
      invitations: 1,
    }
    expect(stateOf(facts)).toMatchObject({
      datos: "falta",
      catalogo: "hecho",
      pagos: "hecho",
      entregas: "hecho",
      sofi: "hecho",
      // Invitó a alguien: aunque todavía no acepta, el paso está hecho.
      equipo: "hecho",
    })
  })

  it("el equipo queda hecho con alguien más, aunque no haya invitaciones", () => {
    expect(stateOf({ ...NEW, members: 2 }).equipo).toBe("hecho")
  })

  it("se salta lo que no aplica a toda tienda; lo que toda tienda necesita, no", () => {
    expect(SKIPPABLE_STEPS).toEqual(["sofi", "equipo"])
    const states = stateOf(NEW, ["equipo", "sofi", "pagos"])
    expect(states).toMatchObject({ equipo: "saltado", sofi: "saltado", pagos: "falta" })
    // Hecho manda sobre saltado: si después invita a alguien, está hecho.
    expect(stateOf({ ...NEW, members: 3 }, ["equipo"]).equipo).toBe("hecho")
  })

  it("con todo hecho o saltado queda lista; los chats, mientras no se pueden conectar, no cuentan", () => {
    expect(CHATS_READY).toBe(false)
    const ready: SetupFacts = {
      ...NEW,
      productsWithStock: 2,
      payments: ["Yape"],
      deliveries: ["Recojo en tienda"],
    }
    expect(setupFinished(setupSteps(ready, []))).toBe(false)
    expect(setupFinished(setupSteps(ready, ["sofi", "equipo"]))).toBe(true)
    // Con los chats ya conectables y sin conectar, falta ese paso.
    expect(setupFinished(setupSteps({ ...ready, chats: false }, ["sofi", "equipo"]))).toBe(false)
    expect(setupFinished(setupSteps({ ...ready, chats: true }, ["sofi", "equipo"]))).toBe(true)
  })
})
