import { describe, expect, it } from "vitest"
import { invitationDueWords } from "./invitation-words"

// La lista de espera (columna Plazo, cabecera del cajón y «Reenviar»), Inicio y la ficha › Equipo
// dicen el vencimiento con esta función: el día es el de Lima, aunque el navegador esté en otra zona.
describe("el vencimiento de una invitación", () => {
  const expiresAt = "2026-11-14T03:00:00Z" // vie 13 nov, 22:00 en Lima

  it("se dice con el día de Lima", () => {
    expect(invitationDueWords(expiresAt, new Date("2026-11-11T15:00:00Z"))).toEqual({
      text: "vence el vie 13 nov",
      expired: false,
      urgent: false,
    })
  })

  it("el mismo día es «vence hoy», en rojo", () => {
    expect(invitationDueWords(expiresAt, new Date("2026-11-13T15:00:00Z"))).toEqual({
      text: "vence hoy",
      expired: false,
      urgent: true,
    })
  })

  it("pasada la hora es «venció», en rojo", () => {
    expect(invitationDueWords(expiresAt, new Date("2026-11-16T15:00:00Z"))).toMatchObject({
      text: "venció el vie 13 nov",
      expired: true,
      urgent: true,
    })
  })
})
