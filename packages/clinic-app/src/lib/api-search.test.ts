import { describe, expect, it } from "vitest"
import { SEARCH_HEADER, searchOutOfPath } from "./api"

describe("searchOutOfPath: lo buscado no viaja en la dirección (QA de la ficha del 10 nov, M4)", () => {
  it("saca `q` de una lectura y lo pone codificado en la cabecera, con lo demás intacto", () => {
    const out = searchOutOfPath(`/api/people?ver=todos&limit=4&q=${encodeURIComponent("Peña Núñez +44")}`)
    expect(out.path).toBe("/api/people?ver=todos&limit=4")
    expect(decodeURIComponent(out.headers[SEARCH_HEADER]!)).toBe("Peña Núñez +44")
    expect(out.path).not.toContain("Pe")
  })

  it("sin otros parámetros, la dirección queda sin «?»", () => {
    expect(searchOutOfPath("/api/search?q=Ana").path).toBe("/api/search")
  })

  it("no toca lo que no es una lectura ni lo que no busca", () => {
    expect(searchOutOfPath("/api/search?q=Ana", "POST")).toEqual({ path: "/api/search?q=Ana", headers: {} })
    expect(searchOutOfPath("/api/people?ver=todos")).toEqual({ path: "/api/people?ver=todos", headers: {} })
  })
})
