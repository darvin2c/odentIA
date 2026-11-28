import { describe, expect, it } from "vitest"
import { readPaste } from "./pegar"

const rows = ["35", "36", "37", "38", "39"].map((v) => ({ id: `t${v}`, label: v }))
const columns = [
  { id: "cd", label: "dorada" },
  { id: "cn", label: "negro" },
]
const parse = (text: string) => {
  const t = text.trim()
  if (t === "") return null
  return /^\d+$/.test(t) ? t : undefined
}
const at = { r: 0, c: 0 }
const names = { row: "talla", column: "color" }
const table = (text: string) => text.split("\n").map((line) => line.split("\t"))
const value = (
  cells: { row: string; column: string; value: string | null }[],
  r: string,
  c: string,
) => cells.find((x) => x.row === r && x.column === c)?.value

describe("pegar desde Excel", () => {
  it("con la fila de colores y la columna de tallas, alinea por nombre y no pega los títulos", () => {
    const { cells, missed } = readPaste(
      table("Talla\tdorada\tnegro\n35\t2\t4\n36\t5\t6\n37\t7\t8\n38\t9\t1\n39\t2\t2"),
      rows,
      columns,
      { r: 2, c: 1 },
      parse,
      names,
    )
    expect(cells).toHaveLength(10)
    expect(value(cells, "t35", "cd")).toBe("2")
    expect(value(cells, "t36", "cn")).toBe("6")
    expect(value(cells, "t39", "cd")).toBe("2")
    // Ninguna talla entró como stock.
    expect(cells.some((c) => ["35", "36", "37", "38", "39"].includes(c.value ?? ""))).toBe(false)
    expect(missed).toEqual([])
  })

  it("en otro orden que la cuadrícula, cada número va a su talla y su color", () => {
    const { cells } = readPaste(
      table("\tnegro\tdorada\n37\t1\t2\n35\t3\t4"),
      rows,
      columns,
      at,
      parse,
      names,
    )
    expect(value(cells, "t37", "cn")).toBe("1")
    expect(value(cells, "t37", "cd")).toBe("2")
    expect(value(cells, "t35", "cn")).toBe("3")
    expect(value(cells, "t35", "cd")).toBe("4")
  })

  it("con las tallas de lado (al revés que la cuadrícula), también se entiende", () => {
    const { cells } = readPaste(
      table("Color\t35\t36\ndorada\t1\t2\nnegro\t3\t4"),
      rows,
      columns,
      at,
      parse,
      names,
    )
    expect(value(cells, "t35", "cd")).toBe("1")
    expect(value(cells, "t36", "cd")).toBe("2")
    expect(value(cells, "t35", "cn")).toBe("3")
    expect(value(cells, "t36", "cn")).toBe("4")
  })

  it("dice lo que no entró: una talla o un color que no está y lo que no es un número", () => {
    const { cells, missed } = readPaste(
      table("Talla\tdorada\tazul\n35\t2\t4\n43\t5\t6\n36\tx\t1"),
      rows,
      columns,
      at,
      parse,
      names,
    )
    expect(cells).toEqual([{ row: "t35", column: "cd", value: "2" }])
    expect(missed).toEqual(
      expect.arrayContaining([
        "color «azul» (no está en la ficha)",
        "talla «43» (no está en la ficha)",
        "«x» en 36 dorada (no vale aquí)",
      ]),
    )
  })

  it("solo números: se pegan desde la celda elegida y lo que no cabe se dice", () => {
    const { cells, missed } = readPaste(
      table("2\t4\t9\n5\t6\t9"),
      rows,
      columns,
      { r: 3, c: 0 },
      parse,
      names,
    )
    expect(value(cells, "t38", "cd")).toBe("2")
    expect(value(cells, "t39", "cn")).toBe("6")
    expect(cells).toHaveLength(4)
    expect(missed).toEqual(["2 valores que no caben"])
  })
})
