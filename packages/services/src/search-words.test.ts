import { describe, expect, it } from "vitest"
import { everydayServiceVariants } from "./search-text"

describe("buscar un servicio como lo dicen los pacientes", () => {
  it("«limpieza» también busca la profilaxis, y lo demás de la búsqueda se conserva", () => {
    expect(everydayServiceVariants("limpieza")).toEqual(["profilaxis", "destartraje", "tartrectomia"])
    expect(everydayServiceVariants("Curación simple")).toContain("restauracion simple")
    expect(everydayServiceVariants("profilaxis")).toEqual([])
  })
})
