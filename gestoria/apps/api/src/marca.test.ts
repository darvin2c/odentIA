/**
 * «Tu marca» sin base (tablero 10 y 21): qué nombres del link valen y cómo se leen el color y el
 * nombre que ve el cliente. Lo que guarda la base y quién lo cambia, en `app.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { brandInput, LINK_NAME_MAX, linkNameProblem, RESERVED_LINK_NAMES } from "./marca.js"

describe("el nombre del link", () => {
  it("vale con letras sin tilde, números y guiones sueltos", () => {
    for (const name of ["calzadosrosa", "calzados-rosa", "hoja-viva-2", "abc"])
      expect(linkNameProblem(name), name).toBeNull()
  })

  it("dice qué tiene mal uno que no vale", () => {
    expect(linkNameProblem("ab")).toMatch(/al menos 3/)
    expect(linkNameProblem("a".repeat(LINK_NAME_MAX + 1))).toMatch(/Hasta 63/)
    for (const name of ["calzados rosa", "niñas", "rosá", "Rosa", "rosa_y_ana"])
      expect(linkNameProblem(name), name).toMatch(/sin tildes/)
    for (const name of ["-rosa", "rosa-", "rosa--ana"])
      expect(linkNameProblem(name), name).toMatch(/guion/)
  })

  it("bloquea los reservados y los que se les parecen", () => {
    for (const word of RESERVED_LINK_NAMES) expect(linkNameProblem(word), word).toMatch(/reservado/)
    for (const name of [
      "adm1n",
      "4dm1n",
      "pago-facil",
      "soporte24",
      "l0gin",
      "mi-gestoria",
      "tugestoria",
    ])
      expect(linkNameProblem(name), name).toMatch(/reservado/)
    // Una palabra reservada dentro de otra no la bloquea (salvo gestorIA): «apparel» no es «app».
    expect(linkNameProblem("apparel")).toBeNull()
    expect(linkNameProblem("pagoda")).toBeNull()
  })
})

describe("lo que se escribe en Tu marca", () => {
  it("el color va en minúsculas con su #; vacío vuelve al de gestorIA", () => {
    const read = (brandColor: string) =>
      brandInput.safeParse({ publicName: "", brandColor, link: null })
    expect(read("BE185D").data?.brandColor).toBe("#be185d")
    expect(read(" #be185d ").data?.brandColor).toBe("#be185d")
    expect(read("").data?.brandColor).toBeNull()
    expect(read("#be18").success).toBe(false)
    expect(read("rojo").success).toBe(false)
  })

  it("el nombre que ve el cliente, vacío, es el de la tienda; el link, en minúsculas", () => {
    const parsed = brandInput.parse({ publicName: "  ", brandColor: "", link: " Calzados-Rosa " })
    expect(parsed).toEqual({ publicName: null, brandColor: null, link: "calzados-rosa" })
    const bad = brandInput.safeParse({ publicName: "", brandColor: "", link: "pagos" })
    expect(bad.success).toBe(false)
  })
})
