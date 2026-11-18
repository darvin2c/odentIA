import { expect, it } from "vitest"
import { sameItems } from "./select"

it("los items del Select con el mismo contenido son los mismos, aunque sean otro objeto", () => {
  expect(sameItems({ a: "Uno", b: "Dos" }, { a: "Uno", b: "Dos" })).toBe(true)
  expect(sameItems({ a: "Uno", b: "Dos" }, { a: "Uno", b: "Tres" })).toBe(false)
  expect(sameItems({ a: "Uno" }, { a: "Uno", b: "Dos" })).toBe(false)
  expect(sameItems([{ value: "a", label: "Uno" }], [{ value: "a", label: "Uno" }])).toBe(true)
  expect(sameItems([{ value: "a", label: "Uno" }], [{ value: "b", label: "Uno" }])).toBe(false)
  expect(sameItems([{ value: "a", label: "Uno" }], { a: "Uno" })).toBe(false)
  expect(sameItems(undefined, undefined)).toBe(true)
  expect(sameItems(undefined, { a: "Uno" })).toBe(false)
})
