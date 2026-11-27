/**
 * Leer la hoja que la tienda ya tiene (decisión 4): Excel además del CSV, y las tallas en
 * columnas además de en filas. Todo pasa por la misma revisión de «Subir una hoja».
 */
import { strToU8, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { planSheet, readSheetBytes } from "./hoja.js"
import { readXlsx } from "./leer-hoja.js"

/** Un .xlsx mínimo como lo guarda Excel: textos compartidos, números y una celda vacía. */
function xlsx(rows: (string | number | null)[][]): Uint8Array {
  const shared: string[] = []
  const col = (i: number) => String.fromCharCode(65 + i)
  const sheet = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((cell, c) => {
            if (cell === null) return ""
            const ref = `${col(c)}${r + 1}`
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
            shared.push(cell)
            return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`
          })
          .join("")}</row>`,
    )
    .join("")
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(
      '<workbook><sheets><sheet name="Catálogo" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/hoja1.xml"/></Relationships>',
    ),
    "xl/worksheets/hoja1.xml": strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    "xl/sharedStrings.xml": strToU8(
      `<sst>${shared.map((t) => `<si><t>${esc(t)}</t></si>`).join("")}</sst>`,
    ),
  })
}

describe("leer la hoja de la tienda", () => {
  it("lee un Excel con sus textos, números y celdas vacías", () => {
    const rows = readXlsx(
      xlsx([
        ["Producto", "Precio", "Stock", "Nota"],
        ["Correa & hebilla", 45.5, 10, null],
      ]),
    )
    expect(rows).toEqual([
      ["Producto", "Precio", "Stock", "Nota"],
      ["Correa & hebilla", "45.5", "10"],
    ])
  })

  it("arma una fila por talla cuando las tallas van en columnas", () => {
    const source = readSheetBytes(
      xlsx([
        ["Producto", "Color", "Precio", "36", "37", "38", "Talla 39"],
        ["Zapatilla urbana", "blanca", 129, 2, null, 3, 1],
        ["Zapatilla urbana", "negra", 129, 0, 4, null, null],
      ]),
    )
    expect(Array.isArray(source)).toBe(true)
    const plan = planSheet(source as string[][], "PEN", new Set(), new Set())
    expect(plan.errors).toEqual([])
    expect(plan.products).toHaveLength(1)
    const [zapatilla] = plan.products
    expect(zapatilla!.options).toEqual([
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["36", "38", "39", "37"] },
    ])
    expect(zapatilla!.variants.map((v) => [...v.values, v.stock])).toEqual([
      ["blanca", "36", 2],
      ["blanca", "38", 3],
      ["blanca", "39", 1],
      ["negra", "36", 0],
      ["negra", "37", 4],
    ])
    // El error dice la fila de la hoja de la tienda, no la que se armó.
    expect(zapatilla!.variants.map((v) => v.row)).toEqual([2, 2, 2, 3, 3])
  })

  it("acepta «Talla» y «Color» sueltas en un CSV, con las tallas en filas", () => {
    const plan = planSheet(
      "Producto;Color;Talla;Precio;Stock\nSandalia;beige;36;89;5\nSandalia;beige;37;89;0\n",
      "PEN",
      new Set(),
      new Set(),
    )
    expect(plan.errors).toEqual([])
    expect(plan.products[0]!.options).toEqual([
      { name: "Color", values: ["beige"] },
      { name: "Talla", values: ["36", "37"] },
    ])
  })

  it("el error dice la fila del Excel aunque haya filas en blanco", () => {
    const source = readSheetBytes(
      xlsx([["Producto", "Precio", "Stock"], ["Correa", 45, 1], [null], ["Gorra", "mucho", 1]]),
    )
    const plan = planSheet(source as string[][], "PEN", new Set(), new Set())
    expect(plan.errors).toEqual([{ row: 4, message: expect.stringMatching(/precio/) }])
  })

  it("dice qué pasa con un Excel roto o un zip que no es una hoja", () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    expect(readSheetBytes(broken)).toEqual({ row: 0, message: expect.stringMatching(/Excel/) })
    const notSheet = zipSync({ "hola.txt": strToU8("hola") })
    expect(readSheetBytes(notSheet)).toEqual({ row: 0, message: expect.stringMatching(/hoja/) })
  })
})
