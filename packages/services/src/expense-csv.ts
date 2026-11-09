/**
 * «Descargar» de Gastos: la lista del mes para el contador, en CSV (RFC 4180), con las mismas filas
 * que la pantalla (`getMonthExpenses`) y lo que el contador pide para su registro de compras: el
 * comprobante con su código del país (SUNAT tabla 10 en el Perú), el RUC del proveedor, con qué se
 * pagó y el número de operación. La fecha es la del pago, no la de emisión del comprobante: el
 * encabezado lo dice. Lo anulado va con su estado y su motivo, para que la lista cuadre con lo que
 * el contador ya recibió. A quien no administra comisiones los sueldos y las comisiones le llegan
 * juntos, sin nombres, como en la pantalla (ADR 0166).
 */
import { expenseCategoryWord, expenseReceiptType, formatMoneyInput } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { getMonthExpenses } from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { type CsvCell, type CsvFile, csvFileName, toCsv } from "./report-csv.js"

/** Sin separador de miles y con punto decimal: lo que lee cualquier hoja de cálculo. */
function amount(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined) return ""
  return `${cents < 0 ? "-" : ""}${formatMoneyInput(Math.abs(cents), currency, "en-US")}`
}

/** El día en la zona de la clínica: `YYYY-MM-DD`. */
function localDay(value: Date | string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))
}

export async function expensesMonthCsv(
  tx: Db,
  orgId: string,
  query: { year: number; month: number; branchId?: string; q?: string; category?: string },
  viewer: { seesCommissions: boolean },
): Promise<CsvFile> {
  const [month, zone, branches] = await Promise.all([
    getMonthExpenses(tx, orgId, query, viewer),
    getOrgLocale(tx, orgId),
    tx.select({ id: branch.id, name: branch.name }).from(branch).where(eq(branch.organizationId, orgId)),
  ])
  const branchName = new Map(branches.map((row) => [row.id, row.name]))
  const unit = month.currency
  const header = [
    "Fecha del pago",
    "Concepto",
    "Tipo",
    ...(viewer.seesCommissions ? ["De quién es el sueldo"] : []),
    "Comprobante",
    "Código del comprobante",
    "Número del comprobante",
    "Proveedor",
    "RUC del proveedor",
    "Con qué se pagó",
    "N.º de operación",
    "Moneda",
    "Importe",
    `Valor en ${unit}`,
    "Sede",
    "Estado",
    "Motivo",
    "Corrige a",
  ]
  const rows: CsvCell[][] = month.expenses.map((row) => {
    // La fila junta de sueldos o de comisiones suma pagos con papeles y medios distintos.
    const merged = row.salary || (row.commission && row.id.includes(":"))
    const type = merged ? null : expenseReceiptType(zone.countryCode, row.receiptType)
    const receiptWord = merged ? "Varios" : (type?.label ?? (row.receiptKind && row.receiptKind !== "ninguno" ? row.receiptKind : ""))
    const value = row.currency === unit ? row.amountCents : row.businessCents
    const state = row.voidedAt ? "Anulado" : row.salesTax ? "No suma: impuesto de lo cobrado" : "Vigente"
    const was = row.replaced
    return [
      localDay(row.spentAt, month.timezone),
      row.concept,
      expenseCategoryWord(row.category),
      ...(viewer.seesCommissions ? [row.personName ?? ""] : []),
      receiptWord,
      type?.code ?? "",
      merged ? "" : (row.receiptNumber ?? ""),
      merged ? "" : (row.supplierName ?? ""),
      merged ? "" : (row.supplierTaxId ?? ""),
      merged ? "Varios" : (row.methodName ?? (row.fromCash ? "Efectivo de la caja" : "")),
      merged ? "" : (row.paymentReference ?? ""),
      row.currency,
      amount(row.amountCents, row.currency),
      amount(value, unit),
      branchName.get(row.branchId) ?? "",
      state,
      row.voidedAt ? (row.voidReason ?? "") : (was?.reason ?? ""),
      was ? `${was.concept} · ${was.currency} ${amount(was.amountCents, was.currency)} · ${localDay(was.spentAt, month.timezone)}` : "",
    ]
  })
  const place = query.branchId ? branchName.get(query.branchId) : null
  const period = `${query.year}-${String(query.month).padStart(2, "0")}`
  return { filename: csvFileName(place ? `Gastos ${place}` : "Gastos", period), body: toCsv(header, rows) }
}
