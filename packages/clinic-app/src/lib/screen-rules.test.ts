import { canAccess, ORG_ROLES } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import { financeAccess, financeCommissionsSubtitle, homeToday } from "./screen-rules"

describe("la tarjeta de hoy mientras carga Inicio", () => {
  const expected = {
    owner: { card: "undecided", cashLine: true },
    admin: { card: "undecided", cashLine: true },
    reception: { card: "agenda", cashLine: false },
    clinician: { card: "patients", cashLine: false },
    cashier: { card: "cash", cashLine: false },
    member: { card: null, cashLine: false },
  } as const

  it.each(ORG_ROLES)("%s ve lo que tendrá, sin anticipar lo que depende de sus citas", (role) => {
    expect(homeToday(role, (permission) => canAccess(role, permission))).toEqual(expected[role])
  })
})

describe("el subtítulo de Finanzas en la pestaña de comisiones", () => {
  const expected = {
    owner: "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró",
    admin: "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró",
    reception: null,
    clinician: "Mis honorarios",
    // Caja no ve comisiones ni tiene honorarios: junto a «Sin acceso a comisiones» no se nombran.
    cashier: null,
    member: null,
  } as const

  it.each(ORG_ROLES)("%s", (role) => {
    expect(financeCommissionsSubtitle(financeAccess((permission) => canAccess(role, permission)))).toBe(expected[role])
  })
})
