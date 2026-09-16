import { describe, expect, it } from "vitest"
import { isNavItemActive } from "./app-shell.js"

describe("isNavItemActive", () => {
  it("exact para /", () => {
    expect(isNavItemActive("/", "/")).toBe(true)
    expect(isNavItemActive("/mesas", "/")).toBe(false)
  })
  it("prefix para subrutas", () => {
    expect(isNavItemActive("/pedidos/123", "/pedidos")).toBe(true)
  })
  it("no falso positivo", () => {
    expect(isNavItemActive("/catalogo", "/cat")).toBe(false)
  })
  it("vacío", () => {
    expect(isNavItemActive("", "/")).toBe(false)
  })
})
