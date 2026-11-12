import { describe, expect, it } from "vitest"
import { demosSearchOf, kairosSearchOf, reportsSearchOf, todaySearchOf } from "./hoy-search"

describe("la dirección de Hoy, Kairós, Reportes y Demos", () => {
  it("lleva siempre cada clave, aunque falte o no sirva", () => {
    expect(todaySearchOf({})).toEqual({ tareas: undefined, producto: undefined })
    expect(Object.keys(todaySearchOf({}))).toEqual(["tareas", "producto"])
    expect(Object.keys(kairosSearchOf({}))).toEqual(["vista", "producto"])
    expect(Object.keys(reportsSearchOf({}))).toEqual(["pestana", "meses"])
    expect(Object.keys(demosSearchOf({}))).toEqual(["producto", "demo"])
  })

  it("descarta lo que la API no entiende", () => {
    expect(todaySearchOf({ tareas: "mias", producto: "veterinaria" })).toEqual({
      tareas: undefined,
      producto: undefined,
    })
    expect(kairosSearchOf({ vista: "otra" }).vista).toBeUndefined()
    expect(reportsSearchOf({ pestana: "costos", meses: 7 })).toEqual({
      pestana: undefined,
      meses: undefined,
    })
  })

  it("lee lo que sirve", () => {
    expect(todaySearchOf({ tareas: "todas", producto: "optical" })).toEqual({
      tareas: "todas",
      producto: "optical",
    })
    expect(kairosSearchOf({ vista: "hizo", producto: "dental" })).toEqual({
      vista: "hizo",
      producto: "dental",
    })
    expect(demosSearchOf({ demo: "abc", producto: "medical" })).toEqual({
      producto: "medical",
      demo: "abc",
    })
  })

  it("los meses del embudo llegan como número o como texto; 6 es el de siempre y no se escribe", () => {
    expect(reportsSearchOf({ meses: 12 }).meses).toBe(12)
    expect(reportsSearchOf({ meses: "3" }).meses).toBe(3)
    expect(reportsSearchOf({ meses: 6 }).meses).toBeUndefined()
    expect(reportsSearchOf({ pestana: "prevision" }).pestana).toBe("prevision")
  })
})
