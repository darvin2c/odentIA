/** Leer la hoja y los importes, y el aviso del costo, sin base. */
import { describe, expect, it } from "vitest"
import { combinations, makeSku } from "./catalogo.js"
import { costWarning, parseMoney } from "./dinero.js"
import { exampleSheet, parseCsv, planSheet } from "./hoja.js"

describe("los importes", () => {
  it("lee punto o coma decimal y la moneda sin decimales; rechaza lo ambiguo", () => {
    expect(parseMoney("129", "PEN")).toBe(12900)
    expect(parseMoney("129,9", "PEN")).toBe(12990)
    expect(parseMoney("S/ 129.90", "PEN")).toBe(12990)
    expect(parseMoney("15000", "CLP")).toBe(15000)
    expect(parseMoney("15000,5", "CLP")).toBeNull()
    expect(parseMoney("1,299.00", "PEN")).toBeNull()
    expect(parseMoney("129.999", "PEN")).toBeNull()
    expect(parseMoney("", "PEN")).toBeNull()
    expect(parseMoney("-5", "PEN")).toBeNull()
  })

  it("el aviso del mínimo: bajo el costo, cerca (10 %) o nada; sin costo, nada", () => {
    expect(costWarning(7000, 6800)).toEqual({ kind: "cerca", costCents: 6800, marginCents: 200 })
    expect(costWarning(6000, 6800)).toEqual({ kind: "perdida", costCents: 6800, lossCents: 800 })
    expect(costWarning(6800, 6800)).toEqual({ kind: "cerca", costCents: 6800, marginCents: 0 })
    expect(costWarning(10000, 6800)).toBeNull()
    expect(costWarning(10000, null)).toBeNull()
    expect(costWarning(null, 6800)).toBeNull()
  })
})

describe("las variantes", () => {
  it("arma todas las combinaciones y un código por cada una, sin repetir", () => {
    expect(
      combinations([
        { name: "Color", values: ["blanca", "negra"] },
        { name: "Talla", values: ["38", "39"] },
      ]),
    ).toEqual([
      ["blanca", "38"],
      ["blanca", "39"],
      ["negra", "38"],
      ["negra", "39"],
    ])
    expect(combinations([])).toEqual([[]])
    const taken = new Set<string>(["zapatillau-blanca-38"])
    expect(makeSku("Zapatilla urbana", ["blanca", "38"], taken)).toBe("ZAPATILLAU-BLANCA-38-2")
    expect(makeSku("Botín café", ["Talla única"], taken)).toBe("BOTINCAFE-TALLAUNI")
    expect(makeSku("¡!", [], taken)).toBe("PROD")
  })
})

describe("la hoja", () => {
  it("lee comillas, saltos de línea dentro de comillas, BOM y el separador de la cabecera", () => {
    expect(parseCsv('﻿a;b\r\n"x;1";"di ""hola""\nsigue"\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x;1", 'di "hola"\nsigue'],
    ])
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("la hoja de ejemplo se lee sin errores", () => {
    const plan = planSheet(exampleSheet(), "PEN", new Set(), new Set())
    expect(plan.errors).toEqual([])
    expect(plan.products.map((p) => [p.name, p.variants.length])).toEqual([
      ["Zapatilla urbana", 3],
      ["Sandalia", 1],
      ["Correa de cuero", 1],
    ])
    const zapatilla = plan.products[0]!
    expect(zapatilla.options).toEqual([
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["38", "39"] },
    ])
    expect(zapatilla.listPriceCents).toBe(12900)
  })

  it("dice qué falta en la cabecera y las opciones que no coinciden entre filas", () => {
    expect(
      planSheet("Nombre;Precio\nx;1", "PEN", new Set(), new Set()).errors[0]?.message,
    ).toContain("«Producto»")
    const plan = planSheet(
      "Producto;Opción 1;Valor 1;Precio;Stock\nPolo;Talla;S;30;1\nPolo;Color;rojo;30;1\nPolo;;;30;1",
      "PEN",
      new Set(),
      new Set(),
    )
    expect(plan.errors.map((e) => e.row)).toEqual([3, 4])
  })

  it("2000 filas contra un catálogo de 2000 productos se revisan rápido (no traba el servidor)", () => {
    const existing = new Set(
      Array.from({ length: 2000 }, (_, i) => `Producto ya cargado número ${i}`),
    )
    const rows = Array.from({ length: 2000 }, (_, i) => `Producto nuevo número ${i};10;1`)
    const started = performance.now()
    const text = ["Producto;Precio;Stock", ...rows].join(String.fromCharCode(10))
    const plan = planSheet(text, "PEN", existing, new Set())
    expect(plan.products).toHaveLength(2000)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
