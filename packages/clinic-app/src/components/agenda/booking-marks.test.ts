import { describe, expect, it } from "vitest"
import { markedForService } from "./booking-drawer"

/**
 * «Reservar la sesión 2» con quien la empezó (mesa del 17 nov, hallazgo 3 de la clínica): para ver a
 * la Dra. Ana se quitaba el servicio, la casilla «Endodoncia · sesión 2 de 2» se desmarcaba sola y
 * la cita se guardaba sin la sesión.
 */
describe("lo marcado para la cita al cambiar el servicio", () => {
  const ofService = (serviceId: string) =>
    serviceId === "corona" ? ["item-corona"] : serviceId === "endo" ? ["item-endo"] : []

  it("quitar el servicio no desmarca la sesión", () => {
    expect(markedForService(["item-endo"], null, ofService)).toEqual(["item-endo"])
  })

  it("otro servicio marca lo suyo, como antes", () => {
    expect(markedForService(["item-endo"], "corona", ofService)).toEqual(["item-corona"])
    expect(markedForService(["item-endo"], "limpieza", ofService)).toEqual([])
  })
})
