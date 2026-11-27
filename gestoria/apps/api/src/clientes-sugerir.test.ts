/**
 * «¿Es la misma clienta?» solo sugiere (entrega 4, tablero 8): el mismo teléfono o el mismo
 * nombre en fichas distintas, sin volver a preguntar lo que una persona ya contestó. Sin base:
 * es la regla sola.
 */
import { describe, expect, it } from "vitest"
import { type MemberRow, nameKey, phoneKey, similarPairs } from "./clientes.js"

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 26, 9, minutes))
const ficha = (
  id: string,
  name: string,
  phoneDigits: string | null,
  minutes: number,
  root = id,
): MemberRow => ({ id, root, name, phoneDigits, createdAt: at(minutes) })

describe("las claves para sugerir", () => {
  it("el nombre, sin mayúsculas, tildes ni espacios de más", () => {
    expect(nameKey("  Mariela   Ríos ")).toBe("mariela rios")
    expect(nameKey("MARIELA RIOS")).toBe(nameKey("mariela ríos"))
    expect(nameKey("Begoña")).toBe("begona")
  })

  it("el teléfono, por sus últimos 8 dígitos: igual con o sin el código del país", () => {
    expect(phoneKey("51987654321")).toBe(phoneKey("987654321"))
    expect(phoneKey("987654321")).toBe("87654321")
    // Con pocos dígitos no se sugiere nada: coincidiría con cualquiera.
    expect(phoneKey("4321")).toBeNull()
    expect(phoneKey(null)).toBeNull()
  })
})

describe("las fichas que podrían ser la misma clienta", () => {
  it("el mismo nombre en dos fichas: se sugiere, la más antigua primero", () => {
    const pairs = similarPairs(
      [ficha("ig", "Mariela Ríos", null, 1), ficha("wa", "mariela rios", "51987654321", 5)],
      [],
    )
    expect(pairs).toEqual([{ a: "ig", b: "wa", reason: "nombre" }])
  })

  it("el mismo teléfono gana al nombre, aunque se llamen distinto", () => {
    const pairs = similarPairs(
      [
        ficha("a", "Mari", "987654321", 1),
        ficha("b", "Mariela Ríos", "+51 987 654 321".replace(/\D/g, ""), 2),
      ],
      [],
    )
    expect(pairs).toEqual([{ a: "a", b: "b", reason: "telefono" }])
  })

  it("dos clientas distintas con todo distinto no se sugieren", () => {
    expect(
      similarPairs(
        [ficha("a", "Valeria Soto", "912345678", 1), ficha("b", "Andrea Castillo", "955210778", 2)],
        [],
      ),
    ).toEqual([])
  })

  it("una ficha que ya está dentro de otra cuenta como esa otra: no se sugiere consigo misma", () => {
    const pairs = similarPairs(
      [
        ficha("raiz", "Mariela Ríos", null, 1),
        ficha("dentro", "Mariela Ríos", "987654321", 2, "raiz"),
        ficha("nueva", "Mari R.", "51987654321", 3),
      ],
      [],
    )
    // «dentro» es «raiz»: la nueva se compara con la ficha que se ve.
    expect(pairs).toEqual([{ a: "raiz", b: "nueva", reason: "telefono" }])
  })

  it("lo que una persona ya contestó no se vuelve a preguntar", () => {
    const members = [ficha("a", "Mariela Ríos", null, 1), ficha("b", "Mariela Ríos", null, 2)]
    expect(similarPairs(members, [{ a: "b", b: "a" }])).toEqual([])
    // Si contestó sobre una ficha que hoy está dentro de otra, vale para esa otra.
    const joined = [
      ficha("a", "Mariela Ríos", null, 1),
      ficha("a2", "Mariela", null, 2, "a"),
      ficha("b", "Mariela Ríos", null, 3),
    ]
    expect(similarPairs(joined, [{ a: "a2", b: "b" }])).toEqual([])
  })

  it("con un nombre muy común, la que acaba de llegar no queda fuera ni la tapan las ya contestadas", () => {
    const old = Array.from({ length: 12 }, (_, i) => ficha(`old${i}`, "María López", null, i))
    const members = [...old, ficha("nueva", "María López", null, 30)]
    // Las viejas ya se contestaron entre ellas y con casi todas: la nueva igual aparece.
    const decided = old.flatMap((a, i) => old.slice(i + 1).map((b) => ({ a: a.id, b: b.id })))
    const pairs = similarPairs(members, decided)
    expect(pairs.length).toBeGreaterThan(0)
    expect(pairs.every((p) => p.b === "nueva")).toBe(true)
  })

  it("solo las de una ficha, aunque haya muchas otras parejas antes", () => {
    const members = [
      ficha("vieja", "Rosa Paz", null, 0),
      ...Array.from({ length: 25 }, (_, i) => [
        ficha(`a${i}`, `Clienta ${i}`, null, i + 1),
        ficha(`b${i}`, `Clienta ${i}`, null, i + 40),
      ]).flat(),
      ficha("otra", "Rosa Paz", null, 1),
    ]
    expect(similarPairs(members, [])).toHaveLength(20)
    expect(similarPairs(members, [], 20, "vieja")).toEqual([
      { a: "vieja", b: "otra", reason: "nombre" },
    ])
  })

  it("las más nuevas primero y con tope", () => {
    const members = [
      ficha("a1", "Ana", null, 1),
      ficha("a2", "Ana", null, 2),
      ficha("b1", "Bea", null, 3),
      ficha("b2", "Bea", null, 9),
    ]
    expect(similarPairs(members, []).map((p) => p.b)).toEqual(["b2", "a2"])
    expect(similarPairs(members, [], 1)).toHaveLength(1)
  })
})
