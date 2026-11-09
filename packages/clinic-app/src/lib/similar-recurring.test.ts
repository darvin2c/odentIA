import { describe, expect, it } from "vitest"
import { type RecurringTemplate, similarRecurring } from "./finance-cash"

const template = (concept: string, category: string, day: number): RecurringTemplate => ({
  id: concept,
  branchId: "b",
  category,
  concept,
  amountCents: 38_000,
  currency: "PEN",
  everyMonths: 1,
  day,
  firstMonth: "2026-11",
  lastMonth: null,
  memberUserId: null,
  memberName: null,
  fromCash: false,
  paymentMethodId: null,
  nextMonth: "2026-11",
  group: null,
})

const templates = [template("Luz Sede Centro", "Servicios", 15), template("Alquiler del local", "Alquiler", 1)]

describe("al anotar lo que se repite, avisa lo que ya se repite y se parece", () => {
  it("una palabra del concepto en común, sin tildes ni mayúsculas", () => {
    expect(similarRecurring(templates, { concept: "luz", category: "", day: null }).map((row) => row.id)).toEqual(["Luz Sede Centro"])
    expect(similarRecurring(templates, { concept: "ALQUILER de la sede", category: "", day: null }).map((row) => row.id)).toEqual([
      "Alquiler del local",
    ])
  })

  it("el mismo tipo el mismo día, aunque se escriba distinto", () => {
    expect(similarRecurring(templates, { concept: "Electricidad", category: "Servicios", day: 15 }).map((row) => row.id)).toEqual([
      "Luz Sede Centro",
    ])
  })

  it("el nombre de la sede no cuenta: «Luz Centro» y «Agua Centro» son otros", () => {
    expect(similarRecurring([template("Luz Centro", "Servicios", 15)], { concept: "Agua Centro", category: "", day: null }, "Centro")).toEqual([])
  })

  it("las palabras de unión no cuentan, ni el tipo en otro día", () => {
    expect(similarRecurring(templates, { concept: "Internet del consultorio", category: "Servicios", day: 20 })).toEqual([])
    expect(similarRecurring(templates, { concept: "", category: "", day: null })).toEqual([])
  })
})
