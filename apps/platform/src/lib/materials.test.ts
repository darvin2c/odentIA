import { describe, expect, it } from "vitest"
import {
  closingMaterialsWords,
  copiedMaterialsWords,
  draftLineOf,
  materialPhrase,
  materialsChanged,
  materialsToSave,
  mergeCopiedMaterials,
  parseWholeQuantity,
  saleDeductionWords,
  saleStockNote,
  withoutMaterialsIntro,
  withoutMaterialsTitle,
} from "./materials"
import type { ServiceMaterialLine } from "./services"

/** Los espacios de `Intl` son duros o estrechos según el entorno: se comparan como espacios. */
const plain = (text: string) => text.replace(/[  ]/g, " ")
/** El porcentaje y los miles tal como los escribe el formato de la clínica en este entorno. */
const percent = (share: number) =>
  plain(
    new Intl.NumberFormat("es-PE", { style: "percent", maximumFractionDigits: 0 }).format(share),
  )
const whole = (value: number) =>
  new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 }).format(value)

function line(
  partial: Partial<ServiceMaterialLine> &
    Pick<ServiceMaterialLine, "productId" | "name" | "unit" | "quantity">,
): ServiceMaterialLine {
  return { quantityText: "", discounted: true, costCents: null, ...partial }
}

describe("un material dicho en una frase", () => {
  it("si el nombre ya empieza por la unidad, no la repite", () => {
    expect(
      materialPhrase({ name: "Guantes de nitrilo", unit: "guante", quantity: 2 }, "es-PE"),
    ).toBe("2 guantes de nitrilo")
    expect(
      materialPhrase({ name: "Guante de nitrilo", unit: "guante", quantity: 1 }, "es-PE"),
    ).toBe("1 guante de nitrilo")
  })

  it("si no, dice la unidad y el nombre, con la sigla intacta", () => {
    expect(
      materialPhrase({ name: "Pasta profiláctica", unit: "sobre", quantity: 1 }, "es-PE"),
    ).toBe("1 sobre de pasta profiláctica")
    expect(materialPhrase({ name: "EDTA 17 %", unit: "frasco", quantity: 3 }, "es-PE")).toBe(
      "3 frascos de EDTA 17 %",
    )
  })

  it("la línea del cierre nombra la sede y junta todo con «y»", () => {
    expect(
      closingMaterialsWords(
        {
          branch: { name: "Sede Miraflores" },
          items: [
            { name: "Guantes de nitrilo", unit: "guante", quantity: 2 },
            { name: "Pasta profiláctica", unit: "sobre", quantity: 1 },
            { name: "Eyector de saliva", unit: "unidad", quantity: 1 },
          ],
        },
        "es-PE",
      ),
    ).toBe(
      "se descuentan de Sede Miraflores: 2 guantes de nitrilo, 1 sobre de pasta profiláctica y 1 unidad de eyector de saliva.",
    )
    expect(
      closingMaterialsWords(
        {
          branch: { name: "Sede Centro" },
          items: [{ name: "Jeringa de resina A2", unit: "jeringa", quantity: 1 }],
        },
        "es-PE",
      ),
    ).toBe("se descuenta de Sede Centro: 1 jeringa de resina A2.")
  })
})

describe("«Empieza por estos 5»", () => {
  const services = [
    { serviceId: "a", name: "Limpieza dental", times: 38 },
    { serviceId: "b", name: "Restauración con resina", times: 22 },
  ]

  it("dice qué parte de las atenciones del último mes son", () => {
    expect(withoutMaterialsTitle(5)).toBe("Empieza por estos 5")
    expect(withoutMaterialsTitle(1)).toBe("Empieza por este")
    expect(plain(withoutMaterialsIntro({ days: 30, share: 0.72, services }, "es-PE"))).toBe(
      `Son el ${percent(0.72)} de tus atenciones del último mes y todavía no tienen materiales:`,
    )
  })

  it("una parte muy chica no se redondea a cero, y sin atenciones no inventa un porcentaje", () => {
    expect(plain(withoutMaterialsIntro({ days: 30, share: 0.003, services }, "es-PE"))).toBe(
      `Son menos del ${percent(0.01)} de tus atenciones del último mes y todavía no tienen materiales:`,
    )
    expect(
      withoutMaterialsIntro({ days: 90, share: null, services: services.slice(0, 1) }, "es-PE"),
    ).toBe("Es el servicio que más se hizo de los últimos 90 días y todavía no tiene materiales:")
  })
})

describe("cantidades escritas a mano", () => {
  it("acepta enteros con el separador de miles de la clínica y rechaza decimales", () => {
    expect(parseWholeQuantity("2", "es-PE")).toBe(2)
    expect(parseWholeQuantity(" 1,000 ", "es-PE")).toBe(1000)
    expect(parseWholeQuantity("1.000", "es-ES")).toBe(1000)
    expect(parseWholeQuantity("1.5", "es-PE")).toBeNull()
    expect(parseWholeQuantity("-2", "es-PE")).toBeNull()
    expect(parseWholeQuantity("", "es-PE")).toBeNull()
  })

  it("los materiales se validan antes de enviar, fila por fila", () => {
    const lines = [
      { productId: "p1", name: "Guantes", unit: "guante", quantityText: "2", discounted: true },
      { productId: "p2", name: "Pasta", unit: "sobre", quantityText: "", discounted: true },
      { productId: "p3", name: "Eyector", unit: "unidad", quantityText: "0", discounted: true },
    ]
    const result = materialsToSave(lines, "es-PE", 9999)
    expect("errors" in result && result.errors).toEqual({
      p2: "Escribe cuánto se usa cada vez.",
      p3: `Va de 1 a ${whole(9999)}.`,
    })
    expect(materialsToSave(lines.slice(0, 1), "es-PE", 9999)).toEqual({
      items: [{ productId: "p1", quantity: 2 }],
    })
  })

  it("solo hay cambios si la lista o alguna cantidad cambió", () => {
    const saved = [line({ productId: "p1", name: "Guantes", unit: "guante", quantity: 2 })]
    const draft = saved.map((item) => draftLineOf(item, "es-PE"))
    expect(materialsChanged(draft, saved, "es-PE")).toBe(false)
    expect(
      materialsChanged(
        draft.map((item) => ({ ...item, quantityText: "4" })),
        saved,
        "es-PE",
      ),
    ).toBe(true)
    expect(materialsChanged([], saved, "es-PE")).toBe(true)
  })
})

describe("«Copiar de otro servicio»", () => {
  it("suma lo que falta, deja lo que ya estaba y no copia lo que ya no se descuenta", () => {
    const current = [
      { productId: "p1", name: "Guantes", unit: "guante", quantityText: "4", discounted: true },
    ]
    const copied = [
      line({ productId: "p1", name: "Guantes", unit: "guante", quantity: 2 }),
      line({ productId: "p2", name: "Pasta", unit: "sobre", quantity: 1 }),
      line({
        productId: "p3",
        name: "Fresa vieja",
        unit: "unidad",
        quantity: 1,
        discounted: false,
      }),
    ]
    const result = mergeCopiedMaterials(current, copied, "es-PE")
    expect(result.lines.map((item) => [item.productId, item.quantityText])).toEqual([
      ["p1", "4"],
      ["p2", "1"],
    ])
    expect(copiedMaterialsWords("Limpieza dental", result)).toBe(
      "Se copió 1 material de «Limpieza dental»; 1 ya estaba y queda con su cantidad; 1 ya no se usa en las atenciones. Revisa las cantidades y guarda.",
    )
    expect(copiedMaterialsWords("Consulta", { added: 0, kept: 0, skipped: 0 })).toBe(
      "«Consulta» no tiene materiales.",
    )
  })
})

describe("vender desde «Cobrar»", () => {
  it("avisa si no hay o no alcanza, y deja agregarlo igual", () => {
    expect(saleStockNote({ onHand: 0, onHandText: null }, 1, "Sede Miraflores")).toBe(
      "No hay en Sede Miraflores: quedará como faltante.",
    )
    expect(saleStockNote({ onHand: -3, onHandText: null }, 1, "Sede Miraflores")).toBe(
      "No hay en Sede Miraflores: quedará como faltante.",
    )
    expect(saleStockNote({ onHand: 1, onHandText: "1 frasco" }, 2, "Sede Miraflores")).toBe(
      "En Sede Miraflores hay 1 frasco: lo que falta quedará como faltante.",
    )
    expect(saleStockNote({ onHand: 4, onHandText: "4 frascos" }, 2, "Sede Miraflores")).toBeNull()
  })

  it("dice cuánto sale de la sede bajo el concepto", () => {
    expect(saleDeductionWords(2, "Sede Miraflores")).toBe("salieron 2 de Sede Miraflores")
    expect(saleDeductionWords(1, "Sede Miraflores")).toBe("salió 1 de Sede Miraflores")
  })
})
