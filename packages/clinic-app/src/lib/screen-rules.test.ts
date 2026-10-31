import { canAccess, ORG_ROLES } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import { homeToday } from "./screen-rules"

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
