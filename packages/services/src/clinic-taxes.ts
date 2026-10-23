import type { Db } from "@odentia/db"
import { orgProfile } from "@odentia/db/schema/org"
import {
  assertTaxRate,
  defaultTaxRates,
  includedTaxCents,
  percentText,
  type OrgTaxes,
  type OrgTaxSettings,
  resolveOrgTaxes,
  type TaxCategory,
  type TaxRate,
  taxProfileFor,
  taxRateLabel,
} from "@odentia/clinical"
import { eq } from "drizzle-orm"
import { validation } from "./errors.js"

/**
 * El impuesto de lo que cobra la clínica (ADR 0083). Las reglas son del país
 * (`@odentia/clinical`, `taxes.ts`); aquí se leen las de una clínica, se valida
 * lo que cambia y se reparte el impuesto de un cobro. Es otra cosa que el
 * impuesto de la factura de odentIA (`SAAS_TAX_BY_COUNTRY`).
 */

type ProfileTaxColumns = Pick<
  typeof orgProfile.$inferSelect,
  "countryCode" | "locale" | "taxLegalForm" | "servicesTaxCategory" | "servicesTaxBps" | "productsTaxCategory" | "productsTaxBps"
>

function storedRate(category: string | null, bps: number | null): TaxRate | null {
  return category && bps !== null ? { category: category as TaxCategory, rateBps: bps } : null
}

/** Las cifras que valen para una clínica a partir de su fila de perfil. */
export function orgTaxesOf(row: ProfileTaxColumns): OrgTaxes | null {
  return resolveOrgTaxes(
    row.countryCode,
    {
      legalForm: row.taxLegalForm,
      servicios: storedRate(row.servicesTaxCategory, row.servicesTaxBps),
      productos: storedRate(row.productsTaxCategory, row.productsTaxBps),
    },
    row.locale,
  )
}

/** Las cifras que valen hoy para la clínica; null sin perfil o si su país no tiene impuesto que separar. */
export async function orgTaxes(tx: Db, orgId: string): Promise<OrgTaxes | null> {
  const [row] = await tx
    .select({
      countryCode: orgProfile.countryCode,
      locale: orgProfile.locale,
      taxLegalForm: orgProfile.taxLegalForm,
      servicesTaxCategory: orgProfile.servicesTaxCategory,
      servicesTaxBps: orgProfile.servicesTaxBps,
      productsTaxCategory: orgProfile.productsTaxCategory,
      productsTaxBps: orgProfile.productsTaxBps,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return row ? orgTaxesOf(row) : null
}

/** Lo que congela un concepto al crearse: la cifra de productos si es una venta; si no, la de atenciones. */
export function chargeTaxOf(taxes: OrgTaxes | null, isProduct: boolean): { taxCategory: TaxCategory; taxBps: number } | null {
  if (!taxes) return null
  const rate = isProduct ? taxes.productos : taxes.servicios
  return { taxCategory: rate.category, taxBps: rate.rateBps }
}

/** Lo que llega de «Datos de la clínica»: null en una cifra es volver a lo del país. */
export interface OrgTaxInput {
  legalForm?: string | null
  servicios?: TaxRate | null
  productos?: TaxRate | null
}

/** Las columnas que se guardan: solo lo que difiere de lo del país; el resto queda nulo. */
export function taxColumnsFor(countryCode: string, input: OrgTaxInput) {
  const profile = taxProfileFor(countryCode)
  if (!profile) {
    if (input.legalForm || input.servicios || input.productos)
      throw validation("odentIA aún no conoce el impuesto de ese país: no hay nada que cambiar")
    return { taxLegalForm: null, servicesTaxCategory: null, servicesTaxBps: null, productsTaxCategory: null, productsTaxBps: null }
  }
  let legalForm: string | null = null
  if (input.legalForm != null) {
    if (!profile.legalForms?.some((form) => form.key === input.legalForm))
      throw validation("Esa forma de la clínica no es una de las de su país")
    legalForm = input.legalForm
  }
  const defaults = defaultTaxRates(profile, legalForm)
  const column = (rate: TaxRate | null | undefined, fallback: TaxRate) => {
    if (!rate) return { category: null, bps: null }
    let checked: TaxRate
    try {
      checked = assertTaxRate(rate)
    } catch (error) {
      throw validation(error instanceof Error ? error.message : "Tasa de impuesto inválida")
    }
    // Una opción sin impuesto tiene que ser una de la lista del país: no se inventan exenciones.
    if (checked.category !== "S" && !profile.choices.some((item) => item.category === checked.category))
      throw validation(`«${taxRateLabel(profile, checked)}» no es una opción de su país`)
    const same = checked.category === fallback.category && checked.rateBps === fallback.rateBps
    return same ? { category: null, bps: null } : { category: checked.category, bps: checked.rateBps }
  }
  const services = column(input.servicios, defaults.servicios)
  const products = column(input.productos, defaults.productos)
  return {
    taxLegalForm: legalForm,
    servicesTaxCategory: services.category,
    servicesTaxBps: services.bps,
    productsTaxCategory: products.category,
    productsTaxBps: products.bps,
  }
}

/** Una línea de lo cobrado hoy, para repartir su impuesto. */
export interface TaxableLine {
  amountCents: number
  /** Nulo: sin impuesto que separar (un concepto de antes del impuesto, o una clínica sin él). */
  taxCategory: string | null
  taxBps: number | null
  scope: "servicios" | "productos"
}

/** Un grupo del ticket: lo cobrado con una misma tasa. */
export interface TicketTaxGroup {
  category: TaxCategory
  rateBps: number
  /** «IGV 18 %», «Exento de IVA». */
  label: string
  /** Lo cobrado con esta tasa, con el impuesto dentro. */
  amountCents: number
  taxCents: number
  /** Qué se cobró sin impuesto, para la línea corta del ticket. */
  scopes: Array<"servicios" | "productos">
}

/** Lo que el ticket congela del impuesto de lo cobrado hoy. */
export interface TicketTaxes {
  /** «IGV», «IVA». */
  name: string
  /** Lo cobrado hoy sin el impuesto. */
  subtotalCents: number
  taxCents: number
  groups: TicketTaxGroup[]
}

/**
 * El impuesto de lo que entra hoy: cada línea redondea el suyo y el ticket los
 * suma, como una boleta. Null si nada lleva impuesto (el ticket queda como
 * antes).
 */
export function ticketTaxesOf(taxes: OrgTaxes | null, lines: TaxableLine[], locale?: string): TicketTaxes | null {
  if (!taxes) return null
  const groups = new Map<string, TicketTaxGroup>()
  let total = 0
  let taxTotal = 0
  for (const line of lines) {
    if (line.amountCents <= 0) continue
    // Un concepto sin impuesto guardado (anterior a él) suma al subtotal: subtotal + impuesto = total.
    if (!line.taxCategory || line.taxBps === null) {
      total += line.amountCents
      continue
    }
    const rate = { category: line.taxCategory as TaxCategory, rateBps: line.taxBps }
    const key = `${rate.category}:${rate.rateBps}`
    const tax = rate.category === "S" ? includedTaxCents(line.amountCents, rate.rateBps) : 0
    const group =
      groups.get(key) ??
      ({
        ...rate,
        label: rate.category === "S" ? `${taxes.name} ${percentText(rate.rateBps, locale)}` : `Sin ${taxes.name}`,
        amountCents: 0,
        taxCents: 0,
        scopes: [],
      } satisfies TicketTaxGroup)
    group.amountCents += line.amountCents
    group.taxCents += tax
    if (!group.scopes.includes(line.scope)) group.scopes.push(line.scope)
    groups.set(key, group)
    total += line.amountCents
    taxTotal += tax
  }
  if (taxTotal === 0) return null
  const ordered = [...groups.values()].sort((a, b) => b.rateBps - a.rateBps)
  return { name: taxes.name, subtotalCents: total - taxTotal, taxCents: taxTotal, groups: ordered }
}

/**
 * Reparte el impuesto del ticket entre sus pagos (uno por medio), en proporción
 * a cada importe; lo que sobra del redondeo va a los de mayor resto, para que
 * la suma sea exacta.
 */
export function splitTaxAcrossPayments(taxCents: number, amounts: number[]): number[] {
  const total = amounts.reduce((sum, value) => sum + value, 0)
  if (taxCents <= 0 || total <= 0) return amounts.map(() => 0)
  const raw = amounts.map((value) => (taxCents * value) / total)
  const parts = raw.map((value) => Math.floor(value))
  let left = taxCents - parts.reduce((sum, value) => sum + value, 0)
  const order = raw.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
  for (const item of order) {
    if (left <= 0) break
    parts[item.index] = (parts[item.index] ?? 0) + 1
    left -= 1
  }
  return parts
}

/** La parte del impuesto de un pago que sale con una devolución de ese pago. */
export function refundTaxCents(payment: { amountCents: number; taxCents: number }, refundCents: number): number {
  if (payment.taxCents <= 0 || payment.amountCents <= 0) return 0
  return Math.min(refundCents, Math.round((payment.taxCents * refundCents) / payment.amountCents))
}

export type { OrgTaxSettings }
