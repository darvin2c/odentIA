import { clinicalProfileFor } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import {
  orderMessage,
  parseWhole,
  purchasePaymentState,
  purchaseQuantityText,
  stateBadge,
  stockText,
  supplierDocChoices,
  supplierDocText,
  supplierShortName,
  withArticle,
} from "./inventory"
import { guessColumns, recognizedText, sheetRows, splitSheet } from "./inventory-paste"

const status = {
  onHand: 0,
  shortage: 0,
  minQuantity: 0,
  missing: 0,
  expired: null,
  expiring: null,
  state: "ok" as const,
  needs: false,
  expires: false,
}

describe("números escritos por la clínica", () => {
  it("lee enteros con cualquier separador de miles y rechaza lo que no es un entero", () => {
    expect(parseWhole("1,050")).toBe(1050)
    expect(parseWhole("1.050")).toBe(1050)
    expect(parseWhole(" 1 050 ")).toBe(1050)
    expect(parseWhole("")).toBeNull()
    expect(parseWhole("tres")).toBeNaN()
    expect(parseWhole("1,5")).toBeNaN()
    expect(parseWhole("-2")).toBeNaN()
  })
})

describe("cómo se dice lo que hay", () => {
  it("suma las cajas solo cuando es exacto", () => {
    const gloves = { unit: "guante", purchaseUnit: "caja", purchaseFactor: 100 }
    expect(stockText(1100, gloves, "en-US")).toBe("1,100 guantes · 11 cajas")
    expect(stockText(1050, gloves, "en-US")).toBe("1,050 guantes")
    expect(stockText(-3, { unit: "jeringa", purchaseUnit: null, purchaseFactor: 1 }, "en-US")).toBe("−3 jeringas")
  })

  it("dice la compra en su unidad con lo que trae", () => {
    expect(purchaseQuantityText(8, { purchaseUnit: "caja", unit: "guante", unitFactor: 100 }, "en-US")).toBe("8 cajas de 100")
    expect(purchaseQuantityText(1, { purchaseUnit: "caja", unit: "cartucho", unitFactor: 50 }, "en-US")).toBe("1 caja de 50")
    expect(purchaseQuantityText(12, { purchaseUnit: null, unit: "jeringa", unitFactor: 1 }, "en-US")).toBe("12 jeringas")
  })

  it("pone el artículo de la unidad", () => {
    expect(withArticle("caja")).toBe("la caja")
    expect(withArticle("unidad")).toBe("la unidad")
    expect(withArticle("frasco")).toBe("el frasco")
  })
})

describe("estado de un producto en la sede", () => {
  it("dice con palabras lo que pide algo y calla lo que está bien", () => {
    expect(stateBadge({ ...status, state: "faltante", shortage: 3 }, "2026-10-19")?.label).toBe("Faltan 3 · se usaron sin haber")
    expect(stateBadge({ ...status, state: "faltante", shortage: 1 }, "2026-10-19")?.label).toBe("Falta 1 · se usó sin haber")
    expect(stateBadge({ ...status, state: "hace_falta", missing: 10 }, "2026-10-19")).toEqual({ label: "Hacen falta 10", tone: "warn" })
    expect(stateBadge({ ...status, state: "hace_falta", missing: 1 }, "2026-10-19")?.label).toBe("Hace falta 1")
    expect(stateBadge({ ...status, state: "no_hay" }, "2026-10-19")?.label).toBe("No hay")
    expect(stateBadge(status, "2026-10-19")).toBeNull()
  })
})

describe("pago de una compra", () => {
  const balance = {
    orderId: "o",
    orderNumber: 14,
    supplierId: "s",
    supplierName: "Dental Andina SAC",
    status: "parcialmente_recibida",
    currency: "PEN",
    branchId: "b",
    branchName: "Miraflores",
    orderedCents: 175_000,
    receivedCents: 66_600,
    cashCents: 0,
    creditCents: 0,
    paidCents: 0,
    dueCents: 66_600,
    aheadCents: 0,
    firstReceivedAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
  }
  const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`
  it("dice lo que falta pagar y lo adelantado, nunca solo con color", () => {
    expect(purchasePaymentState({ status: "parcialmente_recibida" }, balance, money)).toEqual({ label: "Por pagar S/ 666.00", tone: "warning" })
    expect(purchasePaymentState({ status: "confirmada" }, { ...balance, receivedCents: 0, dueCents: 0, paidCents: 20_000 }, money).label).toBe("Adelanto S/ 200.00")
    expect(purchasePaymentState({ status: "borrador" }, null, money).label).toBe("Sin confirmar")
  })
})

describe("documento del proveedor", () => {
  it("ofrece la lista del país con sus etiquetas y guarda el código; sin perfil propio, el núcleo", () => {
    expect(supplierDocChoices(clinicalProfileFor("PE"))).toEqual([
      { value: "RUC", label: "RUC" },
      { value: "DNI", label: "DNI" },
      { value: "CE", label: "Carné de extranjería" },
      { value: "PASAPORTE", label: "Pasaporte" },
      { value: "OTRO", label: "Otro" },
    ])
    expect(supplierDocChoices(clinicalProfileFor("CL")).map((option) => option.value)).toEqual(["TRIBUTARIO", "NACIONAL", "PASAPORTE", "OTRO"])
    // Un tipo escrito a mano antes de la lista se conserva tal cual al editar.
    expect(supplierDocChoices(clinicalProfileFor("PE"), "NIT").at(-1)).toEqual({ value: "NIT", label: "NIT" })
    expect(supplierDocChoices(clinicalProfileFor("PE"), "RUC")).toHaveLength(5)
  })
  it("se lee con la etiqueta del tipo, nunca con su código", () => {
    expect(supplierDocText({ docType: "CE", docNumber: "001234567" })).toBe("Carné de extranjería 001234567")
    expect(supplierDocText({ docType: "TRIBUTARIO", docNumber: "900123456" })).toBe("Documento tributario 900123456")
    expect(supplierDocText({ docType: "NIT", docNumber: "900123456" })).toBe("NIT 900123456")
    expect(supplierDocText({ docType: "RUC", docNumber: null })).toBeNull()
  })
})

describe("copiar el pedido", () => {
  it("arma el texto para WhatsApp sin la forma societaria del proveedor", () => {
    expect(supplierShortName("Dental Andina SAC")).toBe("Dental Andina")
    expect(supplierShortName("Distribuidora Médica Lima S.A.C.")).toBe("Distribuidora Médica Lima")
    const text = orderMessage(
      {
        supplierName: "Dental Andina SAC",
        branchName: "Sede Miraflores",
        notes: "Entregar en la mañana.",
        lines: [
          { productName: "Guantes de nitrilo", quantity: 8, purchaseUnit: "caja", unit: "guante", unitFactor: 100 },
          { productName: "Lidocaína 2% con epinefrina", quantity: 1, purchaseUnit: "caja", unit: "cartucho", unitFactor: 50 },
        ],
      },
      "Dental Smile",
      "en-US",
    )
    expect(text).toBe(
      [
        "Hola, Dental Andina. Somos Dental Smile, Sede Miraflores. Quisiéramos pedir:",
        "· 8 cajas de 100 de Guantes de nitrilo",
        "· 1 caja de 50 de Lidocaína 2% con epinefrina",
        "Entregar en la mañana. Gracias.",
      ].join("\n"),
    )
  })
})

describe("pegar tu lista", () => {
  it("reconoce los títulos de la hoja, también «Stock mínimo»", () => {
    const rows = splitSheet("Producto\tPresentación\tStock\tStock mínimo\nGuantes de nitrilo\tcaja de 100\t11\t10\n\nResina A2\tjeringa\t6\t")
    const guess = guessColumns(rows)
    expect(guess).toEqual({ header: true, columns: ["nombre", "unidad", "hay", "minimo"] })
    expect(sheetRows(rows, guess.header, guess.columns)).toEqual([
      { name: "Guantes de nitrilo", unit: "caja de 100", onHand: "11", minQuantity: "10" },
      { name: "Resina A2", unit: "jeringa", onHand: "6", minQuantity: null },
    ])
    expect(recognizedText(guess.columns)).toBe("Nombre, Unidad, Hay y Mínimo")
  })

  it("sin títulos, deduce por lo que hay en cada columna", () => {
    const rows = splitSheet("Guantes de nitrilo\t11\tcaja\t10\nHilo retractor\ttres\trollo\t1\nResina A2\t6\tjeringa\t")
    expect(guessColumns(rows)).toEqual({ header: false, columns: ["nombre", "hay", "unidad", "minimo"] })
  })
})
