import { describe, expect, it } from "vitest"
import { staffMailAddress } from "./staff-mail"

describe("«Su correo» de cada persona del equipo", () => {
  const row = { userId: "u1", name: "Ana Torres", email: "ana@gmail.com" }

  it("Soporte escribe desde soporte@: su dirección no se muestra ni se corrige", () => {
    expect(staffMailAddress({ ...row, role: "support", mailLocal: "ana.torres" })).toBe("soporte")
    expect(
      staffMailAddress({
        ...row,
        role: "support",
        mailLocal: "ana.torres",
        mailFirstSentAt: "2026-11-01T15:00:00.000Z",
      }),
    ).toBe("soporte")
  })

  it("Administración la corrige hasta que sale el primer correo; después queda fija", () => {
    expect(staffMailAddress({ ...row, role: "admin", mailLocal: "ana.torres" })).toBe("editable")
    expect(staffMailAddress({ ...row, role: "admin", mailLocal: null })).toBe("editable")
    expect(
      staffMailAddress({
        ...row,
        role: "admin",
        mailLocal: "ana.torres",
        mailFirstSentAt: "2026-11-01T15:00:00.000Z",
      }),
    ).toBe("fija")
  })
})
