import { describe, expect, it } from "vitest"
import { MEDICAL_SEARCH } from "../latidia/home/search-data"
import { DENTAL_SEARCH } from "./search-data"
import { looksLikeQuestion, searchDemo, searchDigits, wordsMatch } from "./search-demo"

const owners = (q: string, data = DENTAL_SEARCH) =>
  searchDemo(data, q).owners.map((o) => o.owner.id)

describe("buscador de la demo", () => {
  it("encuentra sin tildes y por el comienzo de cada palabra", () => {
    expect(wordsMatch("lucia", "Lucía Ramos Soto")).toBe(true)
    expect(wordsMatch("soto luc", "Lucía Ramos Soto")).toBe(true)
    expect(wordsMatch("ucia", "Lucía Ramos Soto")).toBe(false)
    expect(owners("lucia")[0]).toBe("lucia")
  })

  it("debajo de quien se encontró por su nombre va lo que coincide y lo pendiente, hasta cuatro y «+ N más»", () => {
    const [lucia] = searchDemo(DENTAL_SEARCH, "lucia").owners
    expect(lucia?.items[0]?.kind).toBe("Mensaje")
    expect(lucia?.items).toHaveLength(4)
    expect(lucia?.more).toBe(1)
    // La radiografía no es pendiente: sale cuando se la busca.
    expect(lucia?.items.some((item) => item.title.startsWith("Radiografía"))).toBe(false)
    expect(owners("radiografia")).toContain("lucia")
  })

  it("un teléfono compartido trae a las dos personas; la historia y el comprobante, por su número", () => {
    expect(owners("987 654")).toEqual(["lucia", "carmen"])
    expect(owners("HC-000123")).toEqual(["lucia"])
    expect(owners("71234567")).toEqual(["lucia"])
    const ticket = searchDemo(DENTAL_SEARCH, "B001-000245").owners[0]
    expect(ticket?.items.map((item) => item.kind)).toEqual(["Comprobante"])
    expect(owners("987 654", MEDICAL_SEARCH)).toEqual(["rosa", "tomas"])
  })

  it("una pregunta pone primero a Argos y no es un nombre que faltó", () => {
    expect(looksLikeQuestion("¿Cuánto cobramos en octubre?")).toBe(true)
    expect(looksLikeQuestion("cuantas consultas hubo")).toBe(true)
    expect(looksLikeQuestion("lucia")).toBe(false)
    expect(searchDemo(DENTAL_SEARCH, "¿Cuánto cobramos en octubre?").question).toBe(true)
  })

  it("el filtro quita un tipo", () => {
    expect(owners("987 654")).toContain("lucia")
    const [lucia] = searchDemo(DENTAL_SEARCH, "lucia", ["conversacion"]).owners
    expect(lucia?.items.some((item) => item.type === "conversacion")).toBe(false)
    expect(searchDemo(DENTAL_SEARCH, "lucia", ["persona", "conversacion"]).owners).toEqual([])
  })

  it("los números cortos o con letras no se buscan por dígitos", () => {
    expect(searchDigits("987")).toBe("")
    expect(searchDigits("987 654")).toBe("987654")
    expect(searchDigits("pieza 36")).toBe("")
  })
})
